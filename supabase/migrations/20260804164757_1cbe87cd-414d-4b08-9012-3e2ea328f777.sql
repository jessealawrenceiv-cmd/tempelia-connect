CREATE OR REPLACE FUNCTION public.has_pending_team_invite()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  em text;
  confirmed timestamptz;
BEGIN
  IF uid IS NULL THEN RETURN false; END IF;

  SELECT lower(email), email_confirmed_at INTO em, confirmed
    FROM auth.users WHERE id = uid;

  IF em IS NULL OR confirmed IS NULL THEN RETURN false; END IF;

  RETURN EXISTS (
    SELECT 1 FROM public.team_members
     WHERE lower(invited_email) = em
       AND accepted_at IS NULL
       AND (staff_user_id IS NULL OR staff_user_id = uid)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.has_pending_team_invite() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.has_pending_team_invite() TO authenticated;