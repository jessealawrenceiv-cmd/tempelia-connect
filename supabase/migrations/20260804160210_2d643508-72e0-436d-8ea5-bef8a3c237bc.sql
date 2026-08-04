-- 1. team_members table
CREATE TABLE public.team_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  staff_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  invited_email text NOT NULL,
  role text NOT NULL DEFAULT 'staff',
  invited_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX team_members_owner_email_key
  ON public.team_members (business_owner_id, lower(invited_email));
CREATE INDEX team_members_staff_idx ON public.team_members (staff_user_id) WHERE staff_user_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.team_members TO authenticated;
GRANT ALL ON public.team_members TO service_role;

ALTER TABLE public.team_members ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owners manage own team members" ON public.team_members
  FOR ALL TO authenticated
  USING (business_owner_id = auth.uid())
  WITH CHECK (business_owner_id = auth.uid());

CREATE POLICY "Staff read own membership row" ON public.team_members
  FOR SELECT TO authenticated
  USING (staff_user_id = auth.uid());

CREATE TRIGGER team_members_set_updated_at
  BEFORE UPDATE ON public.team_members
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 2. Standard-tier gate on invite creation
CREATE OR REPLACE FUNCTION public.team_members_enforce_tier()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  tier text;
BEGIN
  SELECT subscription_tier INTO tier FROM public.profiles WHERE id = NEW.business_owner_id;
  IF tier IS DISTINCT FROM 'standard' THEN
    RAISE EXCEPTION 'Team accounts require the Standard plan. Upgrade to invite staff logins.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER team_members_enforce_tier_trg
  BEFORE INSERT ON public.team_members
  FOR EACH ROW EXECUTE FUNCTION public.team_members_enforce_tier();

-- 3. Accepted-team-member check (security definer to avoid RLS recursion)
CREATE OR REPLACE FUNCTION public.is_accepted_team_member(_owner_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.team_members
    WHERE business_owner_id = _owner_id
      AND staff_user_id = auth.uid()
      AND accepted_at IS NOT NULL
  );
$$;

-- 4. Invite claiming on signup/login
CREATE OR REPLACE FUNCTION public.claim_team_invites()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  uid uuid := auth.uid();
  em text;
  n integer := 0;
BEGIN
  IF uid IS NULL THEN RETURN 0; END IF;
  SELECT lower(email) INTO em FROM auth.users WHERE id = uid;
  IF em IS NULL THEN RETURN 0; END IF;

  UPDATE public.team_members
     SET staff_user_id = uid,
         accepted_at = COALESCE(accepted_at, now())
   WHERE lower(invited_email) = em
     AND (staff_user_id IS NULL OR staff_user_id = uid);

  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_team_invites() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_team_invites() TO authenticated;

-- 5. Extend access on shared business tables to accepted staff
CREATE POLICY "Accepted staff access customers" ON public.customers
  FOR ALL TO authenticated
  USING (public.is_accepted_team_member(user_id))
  WITH CHECK (public.is_accepted_team_member(user_id));

CREATE POLICY "Accepted staff access quotes" ON public.quotes
  FOR ALL TO authenticated
  USING (public.is_accepted_team_member(user_id))
  WITH CHECK (public.is_accepted_team_member(user_id));

CREATE POLICY "Accepted staff access appointments" ON public.appointments
  FOR ALL TO authenticated
  USING (public.is_accepted_team_member(user_id))
  WITH CHECK (public.is_accepted_team_member(user_id));

CREATE POLICY "Accepted staff access jobs" ON public.jobs
  FOR ALL TO authenticated
  USING (public.is_accepted_team_member(user_id))
  WITH CHECK (public.is_accepted_team_member(user_id));

CREATE POLICY "Accepted staff access intake submissions" ON public.intake_submissions
  FOR ALL TO authenticated
  USING (public.is_accepted_team_member(user_id))
  WITH CHECK (public.is_accepted_team_member(user_id));

CREATE POLICY "Accepted staff read logs" ON public.logs
  FOR SELECT TO authenticated
  USING (public.is_accepted_team_member(user_id));

CREATE POLICY "Accepted staff insert logs" ON public.logs
  FOR INSERT TO authenticated
  WITH CHECK (public.is_accepted_team_member(user_id));
