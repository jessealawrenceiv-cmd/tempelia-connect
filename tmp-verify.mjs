import { createClient } from '@supabase/supabase-js';
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {auth:{persistSession:false}});
const em='staff1785862767766@example.com';
const {data:rows}=await s.from('team_members').select('business_owner_id,staff_user_id,accepted_at').eq('invited_email',em);
for(const r of rows){const {data:p}=await s.from('profiles').select('business_name').eq('id',r.business_owner_id).single();console.log(p.business_name,'| staff_user_id:',r.staff_user_id?'SET':'null','| accepted_at:',r.accepted_at);}
const c=createClient(process.env.SUPABASE_URL,"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdqaG95Z3JneW15ZHhjcHRjZ3poIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM1MTYwNTgsImV4cCI6MjA5OTA5MjA1OH0.fggexYdRR93c_VKl0vApeXF_IKU_xI90YWma99w0CZo",{auth:{persistSession:false}});
await c.auth.signInWithPassword({email:em,password:'Test1234!pass'});
const {data:cust}=await c.from('customers').select('first_name');
console.log('customers visible to staff:',JSON.stringify(cust));
