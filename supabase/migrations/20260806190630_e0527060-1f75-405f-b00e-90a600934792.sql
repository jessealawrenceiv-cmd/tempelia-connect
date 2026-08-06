ALTER TABLE public.logs DROP CONSTRAINT IF EXISTS logs_action_type_check;
ALTER TABLE public.logs ADD CONSTRAINT logs_action_type_check
  CHECK (
    action_type = ANY (ARRAY[
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
      'customer_consent_preserved',
      'quote_deposit_status',
      'status_refresh',
      'automation_status_change'
    ])
  );