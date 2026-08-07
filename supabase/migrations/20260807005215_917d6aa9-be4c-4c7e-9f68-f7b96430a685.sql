CREATE OR REPLACE FUNCTION public.logs_action_type_whitelist()
RETURNS TABLE(constraint_name text, constraint_def text, allowed_values text[])
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_def text;
BEGIN
  IF NOT public.has_role('admin') THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  SELECT pg_get_constraintdef(oid) INTO v_def
  FROM pg_constraint
  WHERE conname = 'logs_action_type_check';

  RETURN QUERY
  SELECT
    'logs_action_type_check'::text,
    v_def,
    COALESCE(
      (SELECT array_agg(m[1] ORDER BY ord)
       FROM regexp_matches(COALESCE(v_def, ''), '''((?:[^'']|'''')*)''::text', 'g')
         WITH ORDINALITY AS t(m, ord)),
      ARRAY[]::text[]
    );
END;
$$;

REVOKE ALL ON FUNCTION public.logs_action_type_whitelist() FROM public;
GRANT EXECUTE ON FUNCTION public.logs_action_type_whitelist() TO authenticated, service_role;

CREATE TABLE public.log_action_type_drift_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  matched boolean NOT NULL,
  constraint_name text NOT NULL,
  db_values text[] NOT NULL,
  generated_values text[] NOT NULL,
  detail text,
  ran_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT ON public.log_action_type_drift_runs TO authenticated;
GRANT ALL ON public.log_action_type_drift_runs TO service_role;

ALTER TABLE public.log_action_type_drift_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can view drift runs"
  ON public.log_action_type_drift_runs FOR SELECT TO authenticated
  USING (public.has_role('admin'));

CREATE POLICY "Admins can record their own drift runs"
  ON public.log_action_type_drift_runs FOR INSERT TO authenticated
  WITH CHECK (public.has_role('admin') AND actor_user_id = auth.uid());

CREATE INDEX log_action_type_drift_runs_ran_at_idx
  ON public.log_action_type_drift_runs (ran_at DESC);