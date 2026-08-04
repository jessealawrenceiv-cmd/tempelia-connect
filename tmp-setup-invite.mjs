import { createClient } from '@supabase/supabase-js';
const url = process.env.SUPABASE_URL, svc = process.env.SUPABASE_SERVICE_ROLE_KEY;
const a = createClient(url, svc, { auth: { persistSession: false } });
const email = `staff.invite.${Date.now()}@example.com`;
const password = 'TestPass!2345';
const { data: u, error: ue } = await a.auth.admin.createUser({ email, password, email_confirm: true });
if (ue) throw ue;
// owner: pick a profile with standard tier, else upgrade the first owner
let { data: owner } = await a.from('profiles').select('id,business_name,subscription_tier').eq('subscription_tier','standard').limit(1).maybeSingle();
if (!owner) {
  const { data: cnt } = await a.from('customers').select('user_id').limit(1000);
  const counts = {}; (cnt||[]).forEach(r => counts[r.user_id]=(counts[r.user_id]||0)+1);
  const best = Object.entries(counts).sort((x,y)=>y[1]-x[1])[0]?.[0];
  const { data: p } = await a.from('profiles').update({ subscription_tier: 'standard' }).eq('id', best).select('id,business_name').maybeSingle();
  owner = p;
}
const { error: ie } = await a.from('team_members').insert({ business_owner_id: owner.id, invited_email: email, role: 'staff' });
if (ie) throw ie;
const { data: rows } = await a.from('team_members').select('id,invited_email,accepted_at,staff_user_id').eq('invited_email', email);
console.log(JSON.stringify({ email, password, owner, rows }, null, 2));
