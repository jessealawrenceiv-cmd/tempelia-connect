import { createClient } from '@supabase/supabase-js';
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const num = process.env.TWILIO_PHONE_NUMBER;
const id = '7d429771-e89a-4587-95a4-f7cf9d1e7cb5';
const { error, data } = await s.from('profiles').update({ twilio_phone_number: num, voicemail_enabled: false, owner_phone: num }).eq('id', id).select('id, twilio_phone_number, voicemail_enabled, owner_phone').single();
console.log('err:', error, 'row:', data && { id: data.id, has_num: !!data.twilio_phone_number, voicemail_enabled: data.voicemail_enabled, has_owner: !!data.owner_phone });
