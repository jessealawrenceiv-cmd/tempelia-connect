ALTER TABLE public.team_members
  ADD COLUMN IF NOT EXISTS expires_at timestamptz;

UPDATE public.team_members SET expires_at = invited_at + interval '7 days' WHERE expires_at IS NULL;

ALTER TABLE public.team_members
  ALTER COLUMN expires_at SET DEFAULT (now() + interval '7 days'),
  ALTER COLUMN expires_at SET NOT NULL;

CREATE OR REPLACE FUNCTION public.team_members_set_expires_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.expires_at := COALESCE(NEW.invited_at, now()) + interval '7 days';
  ELSIF NEW.invited_at IS DISTINCT FROM OLD.invited_at THEN
    NEW.expires_at := NEW.invited_at + interval '7 days';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS team_members_set_expires_at_trg ON public.team_members;
CREATE TRIGGER team_members_set_expires_at_trg
BEFORE INSERT OR UPDATE ON public.team_members
FOR EACH ROW EXECUTE FUNCTION public.team_members_set_expires_at();

CREATE OR REPLACE FUNCTION public.claim_team_invites()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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
     AND tm.expires_at > now()
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

CREATE OR REPLACE FUNCTION public.claim_team_invite(_invite_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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
     AND (tm.accepted_at IS NOT NULL OR tm.expires_at > now())
     AND (tm.staff_user_id IS NULL OR tm.staff_user_id = uid);

  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n > 0;
END;
$$;

CREATE OR REPLACE FUNCTION public.has_pending_team_invite()
RETURNS boolean
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
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
       AND tm.expires_at > now()
       AND (tm.staff_user_id IS NULL OR tm.staff_user_id = uid)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.has_expired_team_invite()
RETURNS boolean
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
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
       AND tm.expires_at <= now()
       AND (tm.staff_user_id IS NULL OR tm.staff_user_id = uid)
  );
END;
$$;

DROP FUNCTION IF EXISTS public.list_pending_team_invites();
CREATE OR REPLACE FUNCTION public.list_pending_team_invites()
RETURNS TABLE(invite_id uuid, business_owner_id uuid, business_name text, invited_at timestamp with time zone, expires_at timestamp with time zone)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
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
  SELECT tm.id, tm.business_owner_id, COALESCE(p.business_name, ''), tm.invited_at, tm.expires_at
    FROM public.team_members tm
    LEFT JOIN public.profiles p ON p.id = tm.business_owner_id
   WHERE lower(tm.invited_email) = em
     AND tm.accepted_at IS NULL
     AND tm.expires_at > now()
     AND (tm.staff_user_id IS NULL OR tm.staff_user_id = uid)
   ORDER BY tm.invited_at DESC;
END;
$$;