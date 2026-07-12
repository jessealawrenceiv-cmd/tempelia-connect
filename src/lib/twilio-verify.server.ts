// Verify Twilio webhook signatures per
// https://www.twilio.com/docs/usage/webhooks/webhooks-security
import { createHmac, timingSafeEqual } from "crypto";

export async function verifyTwilioRequest(
  request: Request,
): Promise<{ ok: boolean; form: FormData }> {
  const form = await request.formData();
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const signature = request.headers.get("x-twilio-signature") ?? "";

  if (!authToken || !signature) return { ok: false, form };

  // Rebuild the URL Twilio signed. Prefer forwarded proto/host if set.
  const url = new URL(request.url);
  const proto = request.headers.get("x-forwarded-proto");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (proto) url.protocol = `${proto}:`;
  if (host) url.host = host;

  const params: Array<[string, string]> = [];
  for (const [k, v] of form.entries()) params.push([k, String(v)]);
  params.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  let data = url.toString();
  for (const [k, v] of params) data += k + v;

  const expected = createHmac("sha1", authToken).update(data).digest("base64");

  let ok = false;
  try {
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    ok = a.length === b.length && timingSafeEqual(a, b);
  } catch {
    ok = false;
  }

  return { ok, form };
}
