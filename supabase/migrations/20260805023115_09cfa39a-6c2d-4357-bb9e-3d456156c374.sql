-- Seat allowance per plan tier
CREATE OR REPLACE FUNCTION public.tier_seat_limit(_tier text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE lower(coalesce(_tier, 'starter'))
    WHEN 'standard' THEN 5
    ELSE 0
  END;
$$;

GRANT EXECUTE ON FUNCTION public.tier_seat_limit(text) TO authenticated, service_role;

-- Replace the tier gate with a seat-count aware gate
CREATE OR REPLACE FUNCTION public.team_members_enforce_tier()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  tier text;
  seat_limit integer;
  used integer;
BEGIN
  SELECT subscription_tier INTO tier FROM public.profiles WHERE id = NEW.business_owner_id;
  seat_limit := public.tier_seat_limit(tier);

  IF seat_limit <= 0 THEN
    RAISE EXCEPTION 'Team accounts require the Standard plan. Upgrade to invite staff logins.'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT count(*) INTO used
    FROM public.team_members tm
   WHERE tm.business_owner_id = NEW.business_owner_id
     AND tm.id <> NEW.id
     AND (tm.accepted_at IS NOT NULL OR tm.expires_at > now());

  IF used >= seat_limit THEN
    RAISE EXCEPTION 'Seat limit reached: your plan includes % staff seat(s) and % are in use (accepted members plus pending invites). Remove a member or revoke a pending invite to free a seat.',
      seat_limit, used
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

-- Seat usage summary for the signed-in owner
CREATE OR REPLACE FUNCTION public.team_seat_usage()
RETURNS TABLE(tier text, seat_limit integer, seats_used integer, seats_remaining integer)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  t text;
  lim integer;
  used integer;
BEGIN
  IF uid IS NULL THEN RETURN; END IF;
  SELECT subscription_tier INTO t FROM public.profiles WHERE id = uid;
  lim := public.tier_seat_limit(t);
  SELECT count(*) INTO used
    FROM public.team_members tm
   WHERE tm.business_owner_id = uid
     AND (tm.accepted_at IS NOT NULL OR tm.expires_at > now());
  RETURN QUERY SELECT coalesce(t, 'starter'), lim, used, greatest(0, lim - used);
END;
$$;

GRANT EXECUTE ON FUNCTION public.team_seat_usage() TO authenticated;
