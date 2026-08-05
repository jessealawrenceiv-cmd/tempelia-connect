CREATE TABLE public.deposit_jump_debug_events (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  quote_id uuid,
  event_name text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX deposit_jump_debug_events_user_time_idx
  ON public.deposit_jump_debug_events (user_id, occurred_at DESC);
CREATE INDEX deposit_jump_debug_events_quote_idx
  ON public.deposit_jump_debug_events (quote_id);

GRANT SELECT, INSERT, DELETE ON public.deposit_jump_debug_events TO authenticated;
GRANT ALL ON public.deposit_jump_debug_events TO service_role;

ALTER TABLE public.deposit_jump_debug_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users insert their own debug events"
  ON public.deposit_jump_debug_events FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users view their own debug events"
  ON public.deposit_jump_debug_events FOR SELECT TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "Users delete their own debug events"
  ON public.deposit_jump_debug_events FOR DELETE TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "Admins view all debug events"
  ON public.deposit_jump_debug_events FOR SELECT TO authenticated
  USING (public.has_role('admin'));