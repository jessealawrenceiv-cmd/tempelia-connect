// Twilio REST helpers. Server-only.
// SMS callers must have already verified opt-in consent and appended the STOP disclaimer.

export const STOP_SUFFIX = "\n\nReply STOP to unsubscribe.";

// Stable published URL for this project — used as the webhook target on
// numbers we purchase under the master account. Immutable across renames.
export const PROJECT_PUBLIC_BASE = "https://project--8e32f1fd-252b-4fe0-a35d-4ff20cd7fded.lovable.app";
export const INBOUND_SMS_URL = `${PROJECT_PUBLIC_BASE}/api/public/twilio/sms`;
export const INBOUND_VOICE_URL = `${PROJECT_PUBLIC_BASE}/api/public/twilio/voice`;

export interface SendSmsResult {
  sid: string;
  status: string;
}

function twilioCreds() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) {
    throw new Error("Twilio not configured (missing TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN).");
  }
  return { sid, token, auth: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64") };
}

export async function sendTwilioSms(from: string, to: string, body: string): Promise<SendSmsResult> {
  const { sid, auth } = twilioCreds();
  if (!from) throw new Error("This business has no Tempelia number provisioned yet.");

  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
  const params = new URLSearchParams({ To: to, From: from, Body: body });

  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`Twilio ${res.status}: ${text}`);
  const json = JSON.parse(text) as { sid: string; status: string };
  return { sid: json.sid, status: json.status };
}

export interface ProvisionedNumber {
  phoneNumber: string;
  phoneSid: string;
}

// Search available local US numbers by area code and buy the first match.
// Webhooks are configured to point back at this project's public routes.
export async function purchaseLocalNumber(areaCode: string): Promise<ProvisionedNumber> {
  const { sid, auth } = twilioCreds();
  if (!/^\d{3}$/.test(areaCode)) throw new Error("Area code must be 3 digits (e.g. 415).");

  // 1. Search for an available local number in that area code.
  const searchUrl = new URL(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/AvailablePhoneNumbers/US/Local.json`,
  );
  searchUrl.searchParams.set("AreaCode", areaCode);
  searchUrl.searchParams.set("SmsEnabled", "true");
  searchUrl.searchParams.set("VoiceEnabled", "true");
  searchUrl.searchParams.set("PageSize", "5");

  const searchRes = await fetch(searchUrl, { headers: { Authorization: auth } });
  const searchText = await searchRes.text();
  if (!searchRes.ok) throw new Error(`Twilio search ${searchRes.status}: ${searchText}`);
  const searchJson = JSON.parse(searchText) as {
    available_phone_numbers: Array<{ phone_number: string }>;
  };
  const candidate = searchJson.available_phone_numbers?.[0]?.phone_number;
  if (!candidate) throw new Error(`No available numbers found in area code ${areaCode}.`);

  // 2. Purchase it, wiring up SMS + Voice webhooks in the same call.
  const buyUrl = `https://api.twilio.com/2010-04-01/Accounts/${sid}/IncomingPhoneNumbers.json`;
  const buyParams = new URLSearchParams({
    PhoneNumber: candidate,
    SmsUrl: INBOUND_SMS_URL,
    SmsMethod: "POST",
    VoiceUrl: INBOUND_VOICE_URL,
    VoiceMethod: "POST",
  });
  const buyRes = await fetch(buyUrl, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" },
    body: buyParams.toString(),
  });
  const buyText = await buyRes.text();
  if (!buyRes.ok) throw new Error(`Twilio purchase ${buyRes.status}: ${buyText}`);
  const buyJson = JSON.parse(buyText) as { sid: string; phone_number: string };
  return { phoneNumber: buyJson.phone_number, phoneSid: buyJson.sid };
}
