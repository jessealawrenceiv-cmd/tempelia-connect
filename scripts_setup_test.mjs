import { createClient } from '@supabase/supabase-js';
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const num = process.env.TWILIO_PHONE_NUMBER;
console.log('Twilio number (masked):', num.slice(0,3) + '****' + num.slice(-2));
// Get the signed-in user's project - find profile of user who owns quote 4ffa74f2
const { data: q } = await s.from('quotes').select('user_id, customer_id').eq('id', '4ffa74f2-ab73-402e-b0fb-9d2853b011d9').single();
console.log('quote user_id:', q.user_id);
const { error: e1 } = await s.from('profiles').update({ twilio_phone_number: num }).eq('id', q.user_id);
console.log('profile update err:', e1);
// Update the customer_phone on the quote AND the linked customer to that same test number, so we send from our Twilio number to our Twilio number.
const { error: e2 } = await s.from('quotes').update({ customer_phone: num }).eq('id', '4ffa74f2-ab73-402e-b0fb-9d2853b011d9');
console.log('quote phone update err:', e2);
if (q.customer_id) {
  const { error: e3 } = await s.from('customers').update({ phone_number: num, opt_in_consent: true }).eq('id', q.customer_id);
  console.log('customer update err:', e3);
}
