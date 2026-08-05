CREATE TABLE public.admin_access_log (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  actor_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  function_name text NOT NULL,
  row_count integer,
  outcome text NOT NULL DEFAULT 'allowed',
  detail text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.admin_access_log TO authenticated;
GRANT ALL ON public.admin_access_log TO service_role;

ALTER TABLE public.admin_access_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can view admin access log"
  ON public.admin_access_log FOR SELECT TO authenticated
  USING (public.has_role('admin'));

CREATE INDEX admin_access_log_actor_time_idx
  ON public.admin_access_log (actor_user_id, occurred_at DESC);

CREATE OR REPLACE FUNCTION public.admin_access_log_prune()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  DELETE FROM public.admin_access_log WHERE occurred_at < now() - interval '90 days';
$$;