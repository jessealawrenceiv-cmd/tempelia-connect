CREATE TABLE IF NOT EXISTS public.status_refresh_locks (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  run_id uuid,
  locked_at timestamptz,
  released_at timestamptz,
  last_result text,
  last_finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.status_refresh_locks TO authenticated;
GRANT ALL ON public.status_refresh_locks TO service_role;
ALTER TABLE public.status_refresh_locks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view their own refresh lock" ON public.status_refresh_locks;
CREATE POLICY "Users can view their own refresh lock"
  ON public.status_refresh_locks FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP TRIGGER IF EXISTS status_refresh_locks_set_updated_at ON public.status_refresh_locks;
CREATE TRIGGER status_refresh_locks_set_updated_at
  BEFORE UPDATE ON public.status_refresh_locks
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Atomically claim the single-run refresh slot for the calling user.
-- Returns the new run_id, or NULL when a run is already in flight (within TTL).
CREATE OR REPLACE FUNCTION public.status_refresh_try_lock(_ttl_seconds integer DEFAULT 60)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  uid uuid := auth.uid();
  ttl interval;
  new_run uuid := gen_random_uuid();
  claimed uuid;
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = 'insufficient_privilege';
  END IF;
  ttl := make_interval(secs => greatest(5, least(600, coalesce(_ttl_seconds, 60))));

  INSERT INTO public.status_refresh_locks (user_id, run_id, locked_at, released_at)
  VALUES (uid, new_run, now(), NULL)
  ON CONFLICT (user_id) DO UPDATE
     SET run_id = new_run,
         locked_at = now(),
         released_at = NULL
   WHERE public.status_refresh_locks.released_at IS NOT NULL
      OR public.status_refresh_locks.locked_at IS NULL
      OR public.status_refresh_locks.locked_at < now() - ttl
  RETURNING run_id INTO claimed;

  RETURN claimed;
END;
$$;

CREATE OR REPLACE FUNCTION public.status_refresh_release(_run_id uuid, _result text DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  uid uuid := auth.uid();
  n integer := 0;
BEGIN
  IF uid IS NULL OR _run_id IS NULL THEN RETURN false; END IF;
  UPDATE public.status_refresh_locks
     SET released_at = now(),
         last_result = _result,
         last_finished_at = now()
   WHERE user_id = uid AND run_id = _run_id AND released_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.status_refresh_try_lock(integer) FROM public;
REVOKE ALL ON FUNCTION public.status_refresh_release(uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.status_refresh_try_lock(integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.status_refresh_release(uuid, text) TO authenticated, service_role;