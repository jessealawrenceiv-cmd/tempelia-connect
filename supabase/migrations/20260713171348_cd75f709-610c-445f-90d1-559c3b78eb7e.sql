
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS voicemail_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS owner_phone text;

ALTER TABLE public.logs
  ADD COLUMN IF NOT EXISTS voicemail_url text,
  ADD COLUMN IF NOT EXISTS recording_sid text,
  ADD COLUMN IF NOT EXISTS call_sid text;

ALTER TABLE public.logs DROP CONSTRAINT IF EXISTS logs_action_type_check;
ALTER TABLE public.logs ADD CONSTRAINT logs_action_type_check
  CHECK (action_type = ANY (ARRAY[
    'missed_call_text',
    'missed_call_autotext',
    'missed_call_excluded',
    'voicemail_notify',
    'review_request',
    'reactivation_text',
    'customer_email_updated',
    'quote_sms',
    'sms_inbound',
    'customer_consent_preserved'
  ]));

CREATE INDEX IF NOT EXISTS logs_call_sid_idx ON public.logs (call_sid) WHERE call_sid IS NOT NULL;
