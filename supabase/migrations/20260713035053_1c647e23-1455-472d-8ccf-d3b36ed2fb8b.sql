
ALTER TABLE public.logs DROP CONSTRAINT logs_action_type_check;
ALTER TABLE public.logs ADD CONSTRAINT logs_action_type_check
  CHECK (action_type = ANY (ARRAY[
    'missed_call_text',
    'review_request',
    'reactivation_text',
    'customer_email_updated'
  ]));
