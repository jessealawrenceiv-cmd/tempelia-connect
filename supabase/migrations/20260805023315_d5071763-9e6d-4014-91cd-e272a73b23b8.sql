CREATE TABLE public.invite_cleanup_runs (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  ran_at timestamptz NOT NULL DEFAULT now(),
  deleted_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.invite_cleanup_runs TO authenticated;
GRANT ALL ON public.invite_cleanup_runs TO service_role;

ALTER TABLE public.invite_cleanup_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view cleanup runs"
ON public.invite_cleanup_runs FOR SELECT TO authenticated USING (true);

CREATE INDEX idx_invite_cleanup_runs_ran_at ON public.invite_cleanup_runs (ran_at DESC);

CREATE OR REPLACE FUNCTION public.cleanup_expired_team_invites()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  n integer := 0;
BEGIN
  WITH doomed AS (
    DELETE FROM public.team_members tm
     WHERE tm.accepted_at IS NULL
       AND tm.expires_at <= now()
    RETURNING tm.id, tm.business_owner_id, tm.invited_email, tm.expires_at
  ), logged AS (
    INSERT INTO public.team_invite_events
      (business_owner_id, team_member_id, actor_user_id, invited_email, event_type, detail, occurred_at)
    SELECT d.business_owner_id, NULL, NULL, d.invited_email, 'expired',
           'Automatically removed by scheduled cleanup', now()
      FROM doomed d
    RETURNING 1
  )
  SELECT count(*) INTO n FROM logged;

  INSERT INTO public.invite_cleanup_runs (deleted_count) VALUES (n);
  RETURN n;
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_expired_team_invites() FROM public;
GRANT EXECUTE ON FUNCTION public.cleanup_expired_team_invites() TO service_role;