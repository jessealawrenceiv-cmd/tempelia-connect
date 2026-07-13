import { createHmac } from 'crypto';
import { createClient } from '@supabase/supabase-js';

const BASE = 'http://localhost:8080';
const TOKEN = process.env.TWILIO_AUTH_TOKEN;
const NUM = process.env.TWILIO_PHONE_NUMBER;
const TENANT = '7d429771-e89a-4587-95a4-f7cf9d1e7cb5';
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

function sign(url, params) {
  const keys = Object.keys(params).sort();
  let data = url;
  for (const k of keys) data += k + params[k];
  return createHmac('sha1', TOKEN).update(data).digest('base64');
}

async function postForm(path, params, extra = {}) {
  const url = BASE + path + (extra.query ?? '');
  // Signature is computed over the URL Twilio requested. verifyTwilioRequest
  // rebuilds URL from request.url + optional x-forwarded-proto/host. Since we
  // don't send those, use the exact request URL.
  const sig = sign(url, params);
  const body = new URLSearchParams(params).toString();
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'x-twilio-signature': sig,
    },
    body,
  });
  return { status: res.status, text: await res.text() };
}

const CALLER = '+15551239999';

async function runCase(label, voicemailEnabled) {
  console.log('\n===', label, '===');
  await admin.from('profiles').update({ voicemail_enabled: voicemailEnabled }).eq('id', TENANT);
  const callSid = 'CA' + Math.random().toString(36).slice(2, 16).padEnd(14, 'x');
  const params = { From: CALLER, To: NUM, CallSid: callSid, AccountSid: 'AC_test' };
  const t0 = Date.now();
  const r = await postForm('/api/public/twilio/voice', params);
  console.log('voice status', r.status, 'in', Date.now() - t0, 'ms');
  console.log('TwiML:\n' + r.text);
  // Fetch the resulting log row
  const { data: logs } = await admin.from('logs').select('id, action_type, status, message_sent, call_sid, voicemail_url, twilio_message_sid').eq('call_sid', callSid).order('created_at', { ascending: false });
  console.log('logs for this call:', JSON.stringify(logs, null, 2));
  return { callSid, logs };
}

const off = await runCase('CASE A — voicemail OFF', false);
const on = await runCase('CASE B — voicemail ON', true);

// Simulate the Twilio recording callback for CASE B
const logId = on.logs.find(l => l.action_type === 'missed_call_autotext')?.id;
console.log('\n--- simulating recording callback for log', logId, '---');
const fakeRecordingUrl = 'https://api.twilio.com/2010-04-01/Accounts/AC_test/Recordings/RE_fake_' + Date.now();
const recParams = {
  RecordingUrl: fakeRecordingUrl,
  RecordingSid: 'RE_test_' + Date.now(),
  RecordingStatus: 'completed',
  RecordingDuration: '7',
  CallSid: on.callSid,
  From: CALLER,
  Called: NUM,
  AccountSid: 'AC_test',
};
const recRes = await (async () => {
  const url = BASE + '/api/public/twilio/recording?log_id=' + encodeURIComponent(logId);
  const sig = sign(url, recParams);
  const body = new URLSearchParams(recParams).toString();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'x-twilio-signature': sig },
    body,
  });
  return { status: res.status, text: await res.text() };
})();
console.log('recording cb', recRes.status, recRes.text);

const { data: after } = await admin.from('logs').select('id, action_type, status, message_sent, voicemail_url, twilio_message_sid, call_sid').eq('call_sid', on.callSid).order('created_at', { ascending: true });
console.log('final logs for CASE B call:', JSON.stringify(after, null, 2));
