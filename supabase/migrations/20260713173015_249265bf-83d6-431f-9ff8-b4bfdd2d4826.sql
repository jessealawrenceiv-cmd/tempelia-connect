
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS decline_followup_mode text NOT NULL DEFAULT 'off'
    CHECK (decline_followup_mode IN ('off','manual','auto'));

ALTER TABLE public.quotes
  ADD COLUMN IF NOT EXISTS decline_reason text,
  ADD COLUMN IF NOT EXISTS decline_followup_sent_at timestamptz;

CREATE INDEX IF NOT EXISTS quotes_decline_followup_pending_idx
  ON public.quotes (user_id, customer_phone, decline_followup_sent_at DESC)
  WHERE decline_followup_sent_at IS NOT NULL AND decline_reason IS NULL;

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
    'quote_decline_followup',
    'quote_decline_reason_captured',
    'sms_inbound',
    'customer_consent_preserved'
  ]));
