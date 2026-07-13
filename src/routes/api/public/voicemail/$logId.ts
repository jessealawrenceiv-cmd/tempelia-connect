// Authenticated proxy for a Twilio recording. Verifies a short-lived HMAC
// signature (minted by getVoicemailProxyUrl for signed-in owners), fetches
// the recording from Twilio with Basic Auth server-side, and streams the
// audio bytes back to the browser. No Twilio credentials touch the client.
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/voicemail/$logId")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const url = new URL(request.url);
        const exp = Number(url.searchParams.get("exp") ?? "0");
        const sig = url.searchParams.get("sig") ?? "";
        const logId = params.logId;

        const secret = process.env.TWILIO_AUTH_TOKEN;
        if (!secret) return new Response("Server misconfigured", { status: 500 });

        if (!exp || Date.now() > exp) return new Response("Link expired", { status: 403 });

        const { createHmac, timingSafeEqual } = await import("crypto");
        const expected = createHmac("sha256", secret).update(`${logId}.${exp}`).digest("hex");
        let ok = false;
        try {
          const a = Buffer.from(expected);
          const b = Buffer.from(sig);
          ok = a.length === b.length && timingSafeEqual(a, b);
        } catch { ok = false; }
        if (!ok) return new Response("Bad signature", { status: 403 });

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data: row } = await supabaseAdmin
          .from("logs")
          .select("voicemail_url")
          .eq("id", logId)
          .maybeSingle();
        if (!row?.voicemail_url) return new Response("Not found", { status: 404 });

        const sid = process.env.TWILIO_ACCOUNT_SID;
        if (!sid) return new Response("Server misconfigured", { status: 500 });
        const basic = "Basic " + Buffer.from(`${sid}:${secret}`).toString("base64");

        // Forward Range for scrubbing support.
        const range = request.headers.get("range");
        const upstream = await fetch(row.voicemail_url, {
          headers: {
            Authorization: basic,
            ...(range ? { Range: range } : {}),
          },
        });

        if (!upstream.ok && upstream.status !== 206) {
          const text = await upstream.text().catch(() => "");
          return new Response(`Upstream ${upstream.status}: ${text.slice(0, 200)}`, {
            status: upstream.status === 401 ? 502 : upstream.status,
          });
        }

        const headers = new Headers();
        headers.set("Content-Type", upstream.headers.get("content-type") ?? "audio/mpeg");
        const cl = upstream.headers.get("content-length");
        if (cl) headers.set("Content-Length", cl);
        const cr = upstream.headers.get("content-range");
        if (cr) headers.set("Content-Range", cr);
        headers.set("Accept-Ranges", "bytes");
        headers.set("Cache-Control", "private, max-age=60");
        return new Response(upstream.body, { status: upstream.status, headers });
      },
    },
  },
});
