ALTER TABLE public.logs DROP CONSTRAINT logs_action_type_check;
ALTER TABLE public.logs ADD CONSTRAINT logs_action_type_check CHECK (action_type = ANY (ARRAY[
  'missed_call_text'::text,
  'missed_call_autotext'::text,
  'missed_call_excluded'::text,
  'voicemail_notify'::text,
  'review_request'::text,
  'reactivation_text'::text,
  'customer_email_updated'::text,
  'quote_sms'::text,
  'quote_decline_followup'::text,
  'quote_decline_reason_captured'::text,
  'sms_inbound'::text,
  'customer_consent_preserved'::text,
  'quote_deposit_status'::text,
  'status_refresh'::text,
  'automation_status_change'::text,
  'invoice_balance_status'::text,
  'invoice_sms'::text,
  'opt_in_prompt'::text,
  'opt_in_prompt_test'::text,
  'number_provisioned'::text,
  'webhook_delivery_status'::text
]));