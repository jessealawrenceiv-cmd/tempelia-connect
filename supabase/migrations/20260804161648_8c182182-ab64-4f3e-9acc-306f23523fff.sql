CREATE OR REPLACE FUNCTION public.claim_team_invites()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  uid uuid := auth.uid();
  em text;
  confirmed timestamptz;
  n integer := 0;
BEGIN
  IF uid IS NULL THEN RETURN 0; END IF;

  SELECT lower(email), email_confirmed_at
    INTO em, confirmed
    FROM auth.users
   WHERE id = uid;

  IF em IS NULL OR confirmed IS NULL THEN RETURN 0; END IF;

  UPDATE public.team_members
     SET staff_user_id = uid,
         accepted_at = COALESCE(accepted_at, now())
   WHERE lower(invited_email) = em
     AND (staff_user_id IS NULL OR staff_user_id = uid);

  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$function$;