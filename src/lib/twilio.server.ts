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
  if (!sid.startsWith("AC")) {
    throw new Error(
      `TWILIO_ACCOUNT_SID must be your Account SID (starts with "AC"), got "${sid.slice(0, 2)}…". If you have an API Key (SK…), set TWILIO_ACCOUNT_SID to your AC… Account SID and TWILIO_AUTH_TOKEN to the API Key secret, or use the Auth Token directly.`,
    );
  }
  return { sid, token, auth: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64") };
}

export async function sendTwilioSms(from: string, to: string, body: string): Promise<SendSmsResult> {
  const { sid, auth } = twilioCreds();
  if (!from) throw new Error("This business has no Temaro number provisioned yet.");

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

export interface MessageStatus {
  sid: string;
  status: string;
  errorCode: number | null;
  errorMessage: string | null;
  to: string;
  dateSent: string | null;
  /** Unmodified Twilio Message resource, for the raw-payload inspector. */
  raw: Record<string, unknown>;
}

/** Fetch current delivery state for one message (queued/sent/delivered/failed/undelivered). */
export async function fetchTwilioMessage(messageSid: string): Promise<MessageStatus> {
  const { sid, auth } = twilioCreds();
  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages/${messageSid}.json`;
  const res = await fetch(url, { headers: { Authorization: auth } });
  const text = await res.text();
  if (!res.ok) throw new Error(`Twilio ${res.status}: ${text}`);
  const j = JSON.parse(text) as {
    sid: string;
    status: string;
    error_code: number | null;
    error_message: string | null;
    to: string;
    date_sent: string | null;
  };
  return {
    raw: JSON.parse(text) as Record<string, unknown>,
    sid: j.sid,
    status: j.status,
    errorCode: j.error_code ?? null,
    errorMessage: j.error_message ?? null,
    to: j.to,
    dateSent: j.date_sent ?? null,
  };
}

export interface ProvisionedNumber {
  phoneNumber: string;
  phoneSid: string;
}

// Search available local US numbers (optionally by area code) and buy the first match.
// Webhooks are configured to point back at this project's public routes.
export async function purchaseLocalNumber(areaCode?: string): Promise<ProvisionedNumber> {
  const { sid, auth } = twilioCreds();
  if (areaCode && !/^\d{3}$/.test(areaCode)) {
    throw new Error("Area code must be 3 digits (e.g. 415).");
  }

  // 1. Search for an available local number.
  const searchUrl = new URL(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/AvailablePhoneNumbers/US/Local.json`,
  );
  if (areaCode) searchUrl.searchParams.set("AreaCode", areaCode);
  searchUrl.searchParams.set("SmsEnabled", "true");
  searchUrl.searchParams.set("VoiceEnabled", "true");
  searchUrl.searchParams.set("PageSize", "5");

  const searchRes = await fetch(searchUrl, { headers: { Authorization: auth } });
  const searchText = await searchRes.text();
  if (searchRes.status === 401) {
    throw new Error(
      `Twilio rejected the credentials for phone-number search (401). Check that TWILIO_ACCOUNT_SID is your main Account SID (AC…), TWILIO_AUTH_TOKEN is the matching Auth Token, and — if the account is a trial — that it has been upgraded so it can purchase numbers. Raw: ${searchText}`,
    );
  }
  if (!searchRes.ok) throw new Error(`Twilio search ${searchRes.status}: ${searchText}`);
  const searchJson = JSON.parse(searchText) as {
    available_phone_numbers: Array<{ phone_number: string }>;
  };
  const candidate = searchJson.available_phone_numbers?.[0]?.phone_number;
  if (!candidate) throw new Error(areaCode ? `No numbers available in area code ${areaCode}.` : "No local US numbers available right now.");

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

export interface NumberWebhookConfig {
  found: boolean;
  phoneSid: string | null;
  smsUrl: string | null;
  smsMethod: string | null;
  voiceUrl: string | null;
  voiceMethod: string | null;
}

/** Read the live webhook configuration Twilio has stored for one of our numbers. */
export async function fetchNumberWebhookConfig(phoneNumber: string): Promise<NumberWebhookConfig> {
  const { sid, auth } = twilioCreds();
  const url = new URL(`https://api.twilio.com/2010-04-01/Accounts/${sid}/IncomingPhoneNumbers.json`);
  url.searchParams.set("PhoneNumber", phoneNumber);
  const res = await fetch(url, { headers: { Authorization: auth } });
  const text = await res.text();
  if (!res.ok) throw new Error(`Twilio ${res.status}: ${text}`);
  const json = JSON.parse(text) as {
    incoming_phone_numbers: Array<{
      sid: string; sms_url: string | null; sms_method: string | null;
      voice_url: string | null; voice_method: string | null;
    }>;
  };
  const n = json.incoming_phone_numbers?.[0];
  if (!n) return { found: false, phoneSid: null, smsUrl: null, smsMethod: null, voiceUrl: null, voiceMethod: null };
  return {
    found: true,
    phoneSid: n.sid,
    smsUrl: n.sms_url || null,
    smsMethod: n.sms_method || null,
    voiceUrl: n.voice_url || null,
    voiceMethod: n.voice_method || null,
  };
}
