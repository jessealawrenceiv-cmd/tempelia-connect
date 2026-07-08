ALTER TABLE public.integrations
  DROP COLUMN IF EXISTS twilio_account_sid,
  DROP COLUMN IF EXISTS twilio_auth_token,
  DROP COLUMN IF EXISTS twilio_phone_number;