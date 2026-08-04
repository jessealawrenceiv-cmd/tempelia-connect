import { createClient } from '@supabase/supabase-js';
const url = process.env.SUPABASE_URL, srk = process.env.SUPABASE_SERVICE_ROLE_KEY, anon = process.env.VITE_SUPABASE_PUBLISHABLE_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdqaG95Z3JneW15ZHhjcHRjZ3poIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM1MTYwNTgsImV4cCI6MjA5OTA5MjA1OH0.fggexYdRR93c_VKl0vApeXF_IKU_xI90YWma99w0CZo";
const s = createClient(url, srk, { auth: { persistSession: false } });
const stamp = Date.now();
const mk = async (email) => {
  const { data, error } = await s.auth.admin.createUser({ email, password: 'Test1234!pass', email_confirm: true });
  if (error) throw error; return data.user.id;
};
const ownerA = await mk(`ownerA${stamp}@example.com`);
const ownerB = await mk(`ownerB${stamp}@example.com`);
const staffEmail = `staff${stamp}@example.com`;
const staff = await mk(staffEmail);
await s.from('profiles').update({ business_name: 'Alpha Plumbing', subscription_tier: 'standard' }).eq('id', ownerA);
await s.from('profiles').update({ business_name: 'Beta Roofing', subscription_tier: 'standard' }).eq('id', ownerB);
const { error: iA } = await s.from('team_members').insert({ business_owner_id: ownerA, invited_email: staffEmail, invited_at: new Date(Date.now()-3600e3).toISOString() });
const { error: iB } = await s.from('team_members').insert({ business_owner_id: ownerB, invited_email: staffEmail });
console.log('invite errors:', iA, iB);
// sign in as staff and call rpc
const c = createClient(url, anon, { auth: { persistSession: false } });
const { error: se } = await c.auth.signInWithPassword({ email: staffEmail, password: 'Test1234!pass' });
console.log('signin err:', se);
const { data: pending } = await c.rpc('has_pending_team_invite');
console.log('has_pending_team_invite:', pending);
const { data: list } = await c.rpc('list_pending_team_invites');
console.log('list_pending_team_invites:', JSON.stringify(list?.map(r=>({b:r.business_name,id:r.invite_id})),null,1));
const { data: claimed, error: ce } = await c.rpc('claim_team_invites');
console.log('claim_team_invites returned:', claimed, ce);
const pick = list.find(r=>r.business_name==='Alpha Plumbing');
const { data: ok2, error: e2b } = await c.rpc('claim_team_invite', { _invite_id: pick.invite_id });
console.log('explicit claim of Alpha after auto-claim:', ok2, e2b?.message);
console.log('list after claim:', (await c.rpc('list_pending_team_invites')).data?.length);
console.log('has_pending after claim:', (await c.rpc('has_pending_team_invite')).data);
const { data: rows } = await s.from('team_members').select('business_owner_id, staff_user_id, accepted_at').eq('invited_email', staffEmail);
for (const r of rows) {
  const { data: p } = await s.from('profiles').select('business_name').eq('id', r.business_owner_id).single();
  console.log(`  ${p.business_name}: staff_user_id=${r.staff_user_id ? 'SET' : 'null'} accepted_at=${r.accepted_at}`);
}
for (const id of [ownerA, ownerB]) await s.from('customers').insert({ user_id: id, first_name: 'Cust'+id.slice(0,4), phone_number: '+15550001111' });
for (const [name, id] of [['Alpha Plumbing', ownerA], ['Beta Roofing', ownerB]]) {
  const { data: cust } = await c.from('customers').select('id').eq('user_id', id);
  console.log(`staff read access to ${name} customers rows:`, cust?.length);
}
console.log('CLEANUP');
await s.from('team_members').delete().eq('invited_email', staffEmail); await s.from('customers').delete().in('user_id',[ownerA,ownerB]);
for (const id of [ownerA, ownerB, staff]) await s.auth.admin.deleteUser(id);
