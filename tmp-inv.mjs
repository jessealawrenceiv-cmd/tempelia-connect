import { createClient } from '@supabase/supabase-js';
const URL = process.env.SUPABASE_URL, SRK = process.env.SUPABASE_SERVICE_ROLE_KEY, PK = process.env.SUPABASE_PUBLISHABLE_KEY;
const s = createClient(URL, SRK, { auth: { persistSession: false } });
const stamp = Date.now();
const ownerEmail = `owner${stamp}@example.com`, staffEmail = `staff${stamp}@example.com`, pass = 'TestPass!2345';

const mk = async (email) => {
  const { data, error } = await s.auth.admin.createUser({ email, password: pass, email_confirm: true });
  if (error) throw error; return data.user.id;
};
const ownerId = await mk(ownerEmail), staffId = await mk(staffEmail);
await s.from('profiles').update({ business_name: 'Expiry Test Co', subscription_tier: 'standard' }).eq('id', ownerId);

// (a) fresh invite via owner-authenticated client (real path)
const oc = createClient(URL, PK, { auth: { persistSession: false } });
await oc.auth.signInWithPassword({ email: ownerEmail, password: pass });
const { data: ins, error: ie } = await oc.from('team_members').insert({ business_owner_id: ownerId, invited_email: staffEmail, role: 'staff' }).select('id, invited_at, expires_at').single();
console.log('(a) insert err:', ie?.message ?? null);
const diffH = (new Date(ins.expires_at) - new Date(ins.invited_at)) / 3600000;
console.log('(a) invited_at', ins.invited_at, 'expires_at', ins.expires_at, 'delta hours =', diffH);

// (b) backdate the invite to expired
await s.from('team_members').update({ invited_at: new Date(Date.now() - 9*864e5).toISOString() }).eq('id', ins.id);
const { data: back } = await s.from('team_members').select('invited_at, expires_at').eq('id', ins.id).single();
console.log('(b) backdated ->', back);

const sc = createClient(URL, PK, { auth: { persistSession: false } });
await sc.auth.signInWithPassword({ email: staffEmail, password: pass });
console.log('(b) has_pending_team_invite:', (await sc.rpc('has_pending_team_invite')).data);
console.log('(b) has_expired_team_invite:', (await sc.rpc('has_expired_team_invite')).data);
console.log('(b) list_pending_team_invites:', JSON.stringify((await sc.rpc('list_pending_team_invites')).data));
console.log('(b) claim_team_invites ->', JSON.stringify(await sc.rpc('claim_team_invites').then(r => ({d:r.data,e:r.error?.message}))));
console.log('(b) claim_team_invite(id) ->', JSON.stringify(await sc.rpc('claim_team_invite', { _invite_id: ins.id }).then(r => ({d:r.data,e:r.error?.message}))));
const { data: after } = await s.from('team_members').select('staff_user_id, accepted_at').eq('id', ins.id).single();
console.log('(b) row after claim attempts:', after);

console.log(JSON.stringify({ ownerEmail, staffEmail, pass, ownerId, staffId, inviteId: ins.id }));
