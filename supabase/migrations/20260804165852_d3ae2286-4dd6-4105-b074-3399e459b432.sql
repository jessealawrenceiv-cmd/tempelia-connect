CREATE OR REPLACE FUNCTION public.claim_team_invite(_invite_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  uid uuid := auth.uid();
  em text;
  confirmed timestamptz;
  n integer := 0;
BEGIN
  IF uid IS NULL OR _invite_id IS NULL THEN RETURN false; END IF;
  SELECT lower(u.email), u.email_confirmed_at INTO em, confirmed FROM auth.users u WHERE u.id = uid;
  IF em IS NULL OR confirmed IS NULL THEN RETURN false; END IF;

  -- One business per staff user: refuse if already accepted elsewhere
  IF EXISTS (
    SELECT 1 FROM public.team_members tm
     WHERE tm.staff_user_id = uid
       AND tm.accepted_at IS NOT NULL
       AND tm.id <> _invite_id
  ) THEN
    RAISE EXCEPTION 'This account already has staff access to another business. Ask that owner to remove you first.'
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE public.team_members tm
     SET staff_user_id = uid,
         accepted_at = COALESCE(tm.accepted_at, now())
   WHERE tm.id = _invite_id
     AND lower(tm.invited_email) = em
     AND (tm.staff_user_id IS NULL OR tm.staff_user_id = uid);

  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n > 0;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_team_invites()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  uid uuid := auth.uid();
  em text;
  confirmed timestamptz;
  target uuid;
  n integer := 0;
BEGIN
  IF uid IS NULL THEN RETURN 0; END IF;

  SELECT lower(u.email), u.email_confirmed_at INTO em, confirmed FROM auth.users u WHERE u.id = uid;
  IF em IS NULL OR confirmed IS NULL THEN RETURN 0; END IF;

  IF EXISTS (
    SELECT 1 FROM public.team_members tm
     WHERE tm.staff_user_id = uid AND tm.accepted_at IS NOT NULL
  ) THEN
    RETURN 0;
  END IF;

  SELECT tm.id INTO target
    FROM public.team_members tm
   WHERE lower(tm.invited_email) = em
     AND tm.accepted_at IS NULL
     AND (tm.staff_user_id IS NULL OR tm.staff_user_id = uid)
   ORDER BY tm.invited_at DESC, tm.created_at DESC, tm.id
   LIMIT 1;

  IF target IS NULL THEN RETURN 0; END IF;

  UPDATE public.team_members tm SET staff_user_id = uid, accepted_at = now()
   WHERE tm.id = target;

  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

CREATE OR REPLACE FUNCTION public.list_pending_team_invites()
RETURNS TABLE (invite_id uuid, business_owner_id uuid, business_name text, invited_at timestamptz)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  uid uuid := auth.uid();
  em text;
  confirmed timestamptz;
BEGIN
  IF uid IS NULL THEN RETURN; END IF;
  SELECT lower(u.email), u.email_confirmed_at INTO em, confirmed FROM auth.users u WHERE u.id = uid;
  IF em IS NULL OR confirmed IS NULL THEN RETURN; END IF;

  IF EXISTS (
    SELECT 1 FROM public.team_members tm
     WHERE tm.staff_user_id = uid AND tm.accepted_at IS NOT NULL
  ) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT tm.id, tm.business_owner_id, COALESCE(p.business_name, ''), tm.invited_at
    FROM public.team_members tm
    LEFT JOIN public.profiles p ON p.id = tm.business_owner_id
   WHERE lower(tm.invited_email) = em
     AND tm.accepted_at IS NULL
     AND (tm.staff_user_id IS NULL OR tm.staff_user_id = uid)
   ORDER BY tm.invited_at DESC;
END;
$$;

CREATE OR REPLACE FUNCTION public.has_pending_team_invite()
RETURNS boolean
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  uid uuid := auth.uid();
  em text;
  confirmed timestamptz;
BEGIN
  IF uid IS NULL THEN RETURN false; END IF;
  SELECT lower(u.email), u.email_confirmed_at INTO em, confirmed FROM auth.users u WHERE u.id = uid;
  IF em IS NULL OR confirmed IS NULL THEN RETURN false; END IF;

  IF EXISTS (
    SELECT 1 FROM public.team_members tm
     WHERE tm.staff_user_id = uid AND tm.accepted_at IS NOT NULL
  ) THEN
    RETURN false;
  END IF;

  RETURN EXISTS (
    SELECT 1 FROM public.team_members tm
     WHERE lower(tm.invited_email) = em
       AND tm.accepted_at IS NULL
       AND (tm.staff_user_id IS NULL OR tm.staff_user_id = uid)
  );
END;
$$;