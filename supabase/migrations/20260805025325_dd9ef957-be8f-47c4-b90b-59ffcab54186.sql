CREATE TABLE public.webhook_events (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  source text NOT NULL,
  event_kind text NOT NULL,
  from_number text,
  to_number text,
  signature_valid boolean NOT NULL DEFAULT false,
  signature_detail text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  request_path text,
  received_at timestamp with time zone NOT NULL DEFAULT now(),
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

GRANT SELECT ON public.webhook_events TO authenticated;
GRANT ALL ON public.webhook_events TO service_role;

ALTER TABLE public.webhook_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owners and staff can view their webhook events"
ON public.webhook_events FOR SELECT TO authenticated
USING (user_id = auth.uid() OR public.is_accepted_team_member(user_id));

CREATE POLICY "Admins can view unattributed webhook events"
ON public.webhook_events FOR SELECT TO authenticated
USING (user_id IS NULL AND public.has_role('admin'));

CREATE INDEX webhook_events_user_received_idx
  ON public.webhook_events (user_id, received_at DESC);

CREATE OR REPLACE FUNCTION public.webhook_events_prune()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  DELETE FROM public.webhook_events WHERE received_at < now() - interval '30 days';
$$;