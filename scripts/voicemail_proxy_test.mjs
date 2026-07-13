import { createServer } from 'http';
import { createHmac } from 'crypto';
import { createClient } from '@supabase/supabase-js';

const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const SID = process.env.TWILIO_ACCOUNT_SID;
const TOKEN = process.env.TWILIO_AUTH_TOKEN;
const expectedBasic = 'Basic ' + Buffer.from(`${SID}:${TOKEN}`).toString('base64');

// Real MP3 bytes (a tiny valid MPEG-1 Layer III silent frame).
const MP3 = Buffer.from([
  0xff,0xfb,0x90,0x64,0x00,0x0f,0xf0,0x00,0x00,0x69,0x00,0x00,0x00,0x08,0x00,0x00,
  0x0d,0x20,0x00,0x00,0x01,0x00,0x00,0x01,0xa4,0x00,0x00,0x00,0x20,0x00,0x00,0x34,
  0x80,0x00,0x00,0x04,
]);

// Mock upstream — behaves like Twilio recording URL.
const upstream = createServer((req, res) => {
  const auth = req.headers.authorization || '';
  if (auth !== expectedBasic) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Twilio API"' });
    return res.end('unauthorized');
  }
  res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': String(MP3.length) });
  res.end(MP3);
});
await new Promise((r) => upstream.listen(9999, r));
console.log('mock upstream up on :9999');

// 3a. Prove upstream 401s without auth (matches real Twilio behavior).
const unauth = await fetch('http://localhost:9999/rec.mp3');
console.log('3a) upstream unauth →', unauth.status);

// 3b. And 200s with Basic Auth.
const authed = await fetch('http://localhost:9999/rec.mp3', { headers: { Authorization: expectedBasic } });
console.log('3b) upstream with Basic Auth →', authed.status, 'ct=', authed.headers.get('content-type'), 'len=', (await authed.arrayBuffer()).byteLength);

// Insert a test log row pointing at the mock recording.
const TENANT = '7d429771-e89a-4587-95a4-f7cf9d1e7cb5';
const { data: inserted, error: iErr } = await admin.from('logs').insert({
  user_id: TENANT,
  action_type: 'missed_call_autotext',
  status: 'sent',
  message_sent: 'proxy-test row',
  voicemail_url: 'http://localhost:9999/rec.mp3',
  call_sid: 'CAproxytest' + Date.now(),
}).select('id').single();
if (iErr) { console.error('insert err', iErr); process.exit(1); }
const logId = inserted.id;
console.log('inserted log id:', logId);

// Mint signed URL exactly like the server fn would.
function sign(logId, exp) {
  return createHmac('sha256', TOKEN).update(`${logId}.${exp}`).digest('hex');
}
const exp = Date.now() + 5*60*1000;
const sig = sign(logId, exp);
const proxyUrl = `http://localhost:8080/api/public/voicemail/${logId}?exp=${exp}&sig=${sig}`;

// 4. Fetch through the proxy — no Twilio creds in the client request.
const p = await fetch(proxyUrl);
const bytes = new Uint8Array(await p.arrayBuffer());
console.log('4) proxy fetch →', p.status, 'ct=', p.headers.get('content-type'), 'len=', bytes.length, 'first4=', [...bytes.slice(0,4)].map(b=>b.toString(16)).join(' '));

// 5. Bad signature → 403
const bad = await fetch(`http://localhost:8080/api/public/voicemail/${logId}?exp=${exp}&sig=deadbeef`);
console.log('5) bad sig →', bad.status, await bad.text());

// 6. Expired → 403
const expired = Date.now() - 1000;
const expiredSig = sign(logId, expired);
const ex = await fetch(`http://localhost:8080/api/public/voicemail/${logId}?exp=${expired}&sig=${expiredSig}`);
console.log('6) expired →', ex.status, await ex.text());

// 7. Range request forwarded (scrubbing)
const rng = await fetch(proxyUrl, { headers: { Range: 'bytes=0-15' } });
console.log('7) range fetch →', rng.status, 'content-range=', rng.headers.get('content-range'), 'ct=', rng.headers.get('content-type'));

// Cleanup
await admin.from('logs').delete().eq('id', logId);
upstream.close();
