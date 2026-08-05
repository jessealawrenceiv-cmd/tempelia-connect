CREATE TABLE public.debug_log_cleanup_runs (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  ran_at timestamptz NOT NULL DEFAULT now(),
  debug_deleted_count integer NOT NULL DEFAULT 0,
  recovery_deleted_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.debug_log_cleanup_runs TO authenticated;
GRANT ALL ON public.debug_log_cleanup_runs TO service_role;

ALTER TABLE public.debug_log_cleanup_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view cleanup runs"
  ON public.debug_log_cleanup_runs FOR SELECT TO authenticated USING (true);

CREATE OR REPLACE FUNCTION public.cleanup_deposit_jump_debug_events(
  _max_age interval DEFAULT interval '30 days',
  _max_per_user integer DEFAULT 1000
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  d_old integer := 0;
  d_cap integer := 0;
  r_old integer := 0;
  r_cap integer := 0;
BEGIN
  WITH doomed AS (
    DELETE FROM public.deposit_jump_debug_events
     WHERE occurred_at < now() - _max_age
    RETURNING 1
  ) SELECT count(*) INTO d_old FROM doomed;

  WITH ranked AS (
    SELECT id, row_number() OVER (PARTITION BY user_id ORDER BY occurred_at DESC, id DESC) AS rn
      FROM public.deposit_jump_debug_events
  ), doomed AS (
    DELETE FROM public.deposit_jump_debug_events e
     USING ranked r
     WHERE e.id = r.id AND r.rn > _max_per_user
    RETURNING 1
  ) SELECT count(*) INTO d_cap FROM doomed;

  WITH doomed AS (
    DELETE FROM public.deposit_jump_recovery_events
     WHERE occurred_at < now() - _max_age
    RETURNING 1
  ) SELECT count(*) INTO r_old FROM doomed;

  WITH ranked AS (
    SELECT id, row_number() OVER (PARTITION BY user_id ORDER BY occurred_at DESC, id DESC) AS rn
      FROM public.deposit_jump_recovery_events
  ), doomed AS (
    DELETE FROM public.deposit_jump_recovery_events e
     USING ranked r
     WHERE e.id = r.id AND r.rn > _max_per_user
    RETURNING 1
  ) SELECT count(*) INTO r_cap FROM doomed;

  INSERT INTO public.debug_log_cleanup_runs (debug_deleted_count, recovery_deleted_count)
  VALUES (d_old + d_cap, r_old + r_cap);

  RETURN d_old + d_cap + r_old + r_cap;
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_deposit_jump_debug_events(interval, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cleanup_deposit_jump_debug_events(interval, integer) TO service_role;

CREATE INDEX IF NOT EXISTS deposit_jump_debug_events_user_occurred_idx
  ON public.deposit_jump_debug_events (user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS deposit_jump_recovery_events_user_occurred_idx
  ON public.deposit_jump_recovery_events (user_id, occurred_at DESC);