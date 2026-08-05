CREATE TABLE public.deposit_jump_recovery_events (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  quote_id uuid,
  event_id text,
  reason text,
  action text NOT NULL CHECK (action IN ('return_to_top','show_latest','clear_filters','dismiss')),
  ms_since_miss integer CHECK (ms_since_miss IS NULL OR ms_since_miss >= 0),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX deposit_jump_recovery_events_occurred_idx ON public.deposit_jump_recovery_events (occurred_at DESC);
CREATE INDEX deposit_jump_recovery_events_action_idx ON public.deposit_jump_recovery_events (action);

GRANT SELECT, INSERT ON public.deposit_jump_recovery_events TO authenticated;
GRANT ALL ON public.deposit_jump_recovery_events TO service_role;

ALTER TABLE public.deposit_jump_recovery_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users insert their own recovery events"
  ON public.deposit_jump_recovery_events FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users view their own recovery events"
  ON public.deposit_jump_recovery_events FOR SELECT TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "Admins view all recovery events"
  ON public.deposit_jump_recovery_events FOR SELECT TO authenticated
  USING (public.has_role('admin'));