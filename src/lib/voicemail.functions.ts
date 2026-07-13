// Mint a short-lived signed proxy URL for a voicemail recording.
// The <audio> tag cannot supply Twilio Basic Auth, so we proxy the stream
// through /api/public/voicemail/$logId and gate it with an HMAC signature.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const getVoicemailProxyUrl = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ logId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    // Confirm the caller owns this log row (RLS via context.supabase).
    const { data: row, error } = await context.supabase
      .from("logs")
      .select("id, voicemail_url")
      .eq("id", data.logId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!row?.voicemail_url) throw new Error("No recording on this log row.");

    const { createHmac } = await import("crypto");
    const secret = process.env.TWILIO_AUTH_TOKEN;
    if (!secret) throw new Error("Server missing TWILIO_AUTH_TOKEN.");
    const exp = Date.now() + 5 * 60 * 1000; // 5 min
    const sig = createHmac("sha256", secret).update(`${data.logId}.${exp}`).digest("hex");
    return { url: `/api/public/voicemail/${data.logId}?exp=${exp}&sig=${sig}` };
  });
