CREATE TABLE public.sms_consent_events (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  phone_number text NOT NULL,
  keyword text NOT NULL,
  action text NOT NULL CHECK (action IN ('opt_in','opt_out')),
  message_body text,
  twilio_message_sid text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.sms_consent_events TO authenticated;
GRANT ALL ON public.sms_consent_events TO service_role;

ALTER TABLE public.sms_consent_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owners read own sms consent events"
ON public.sms_consent_events FOR SELECT TO authenticated
USING (auth.uid() = user_id);

CREATE POLICY "Accepted staff read sms consent events"
ON public.sms_consent_events FOR SELECT TO authenticated
USING (public.is_accepted_team_member(user_id));

CREATE INDEX idx_sms_consent_events_user_time ON public.sms_consent_events (user_id, occurred_at DESC);
CREATE INDEX idx_sms_consent_events_customer ON public.sms_consent_events (customer_id, occurred_at DESC);
CREATE INDEX idx_sms_consent_events_phone ON public.sms_consent_events (user_id, phone_number, occurred_at DESC);