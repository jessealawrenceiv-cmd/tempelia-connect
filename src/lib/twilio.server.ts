// Shared-account Twilio REST helper. Server-only.
// Callers must have already verified opt-in consent and appended the STOP disclaimer.

export interface SendSmsResult {
  sid: string;
  status: string;
}

export async function sendTwilioSms(to: string, body: string): Promise<SendSmsResult> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_PHONE_NUMBER;

  if (!sid || !token || !from) {
    throw new Error("Twilio not configured (missing TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_PHONE_NUMBER).");
  }

  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
  const auth = "Basic " + Buffer.from(`${sid}:${token}`).toString("base64");
  const params = new URLSearchParams({ To: to, From: from, Body: body });

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: auth,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Twilio ${res.status}: ${text}`);
  }
  const json = JSON.parse(text) as { sid: string; status: string };
  return { sid: json.sid, status: json.status };
}

export const STOP_SUFFIX = "\n\nReply STOP to unsubscribe.";
