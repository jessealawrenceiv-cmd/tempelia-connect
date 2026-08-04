import { createClient } from '@supabase/supabase-js';
const URL = process.env.SUPABASE_URL, SRK = process.env.SUPABASE_SERVICE_ROLE_KEY, ANON = process.env.VITE_SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdqaG95Z3JneW15ZHhjcHRjZ3poIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM1MTYwNTgsImV4cCI6MjA5OTA5MjA1OH0.fggexYdRR93c_VKl0vApeXF_IKU_xI90YWma99w0CZo';
const admin = createClient(URL, SRK, { auth: { persistSession: false } });

// pick a standard-tier owner (or promote one)
let { data: owners } = await admin.from('profiles').select('id,email,subscription_tier').limit(5);
let owner = owners.find(o => o.subscription_tier === 'standard') || owners[0];
if (owner.subscription_tier !== 'standard') {
  await admin.from('profiles').update({ subscription_tier: 'standard' }).eq('id', owner.id);
}
console.log('owner:', owner.id, owner.email);

const inviteeEmail = `invitee.claim.${Date.now()}@example.com`;
const pass = 'Test-Pass-12345!';
const { data: u1, error: ue } = await admin.auth.admin.createUser({ email: inviteeEmail, password: pass, email_confirm: true });
console.log('created confirmed invitee:', u1?.user?.id, 'confirmed_at set:', !!u1?.user?.email_confirmed_at, ue?.message ?? '');

const unconfEmail = `unconfirmed.claim.${Date.now()}@example.com`;
const { data: u2 } = await admin.auth.admin.createUser({ email: unconfEmail, password: pass, email_confirm: false });
console.log('created UNCONFIRMED user:', u2?.user?.id, 'confirmed_at:', u2?.user?.email_confirmed_at ?? null);

const { error: ie } = await admin.from('team_members').insert([
  { business_owner_id: owner.id, invited_email: inviteeEmail },
  { business_owner_id: owner.id, invited_email: unconfEmail },
]);
console.log('invites inserted err:', ie?.message ?? 'none');

async function claimAs(email) {
  const c = createClient(URL, ANON, { auth: { persistSession: false } });
  const { data: s, error } = await c.auth.signInWithPassword({ email, password: pass });
  if (error) return console.log(`[${email}] sign-in blocked: ${error.message}`);
  const { data, error: re } = await c.rpc('claim_team_invites');
  console.log(`[${email}] claim_team_invites =>`, JSON.stringify({ data, error: re?.message ?? null }));
  const { data: rows } = await c.from('team_members').select('invited_email,staff_user_id,accepted_at');
  console.log(`[${email}] visible rows:`, JSON.stringify(rows));
}
await claimAs(inviteeEmail);
// force-confirm-free path: unconfirmed user cannot even get a session normally; bypass by minting session via admin token? Instead show DB state
const { data: rows } = await admin.from('team_members').select('invited_email,staff_user_id,accepted_at').eq('business_owner_id', owner.id);
console.log('final DB state:', JSON.stringify(rows, null, 2));
await claimAs(unconfEmail);
