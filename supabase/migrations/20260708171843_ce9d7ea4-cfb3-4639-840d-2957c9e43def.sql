ALTER TABLE public.profiles
  ADD COLUMN twilio_phone_number text UNIQUE,
  ADD COLUMN twilio_phone_sid text,
  ADD COLUMN twilio_provisioned_at timestamptz;

CREATE INDEX IF NOT EXISTS profiles_twilio_phone_number_idx
  ON public.profiles (twilio_phone_number);