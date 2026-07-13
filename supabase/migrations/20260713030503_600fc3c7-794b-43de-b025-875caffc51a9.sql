-- 1) Explicit deny-all on intake_rate_limits (documentation clarity;
--    all legitimate access is via service role which bypasses RLS).
DROP POLICY IF EXISTS "Deny all direct access" ON public.intake_rate_limits;
CREATE POLICY "Deny all direct access" ON public.intake_rate_limits
  AS RESTRICTIVE FOR ALL TO public
  USING (false) WITH CHECK (false);

-- 2) Drop policies that reference the old has_role(uuid, app_role) signature.
DROP POLICY IF EXISTS "Admins read all roles" ON public.user_roles;
DROP POLICY IF EXISTS "Admins insert roles" ON public.user_roles;
DROP POLICY IF EXISTS "Admins delete roles" ON public.user_roles;

-- 3) Drop old function, create single-arg version.
DROP FUNCTION IF EXISTS public.has_role(uuid, public.app_role);

CREATE OR REPLACE FUNCTION public.has_role(_role public.app_role)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = auth.uid()
      AND role = _role
  );
$$;

REVOKE EXECUTE ON FUNCTION public.has_role(public.app_role) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_role(public.app_role) TO authenticated, service_role;

-- 4) Recreate policies against new signature.
CREATE POLICY "Admins read all roles" ON public.user_roles
  FOR SELECT TO authenticated
  USING (public.has_role('admin'));

CREATE POLICY "Admins insert roles" ON public.user_roles
  FOR INSERT TO authenticated
  WITH CHECK (public.has_role('admin'));

CREATE POLICY "Admins delete roles" ON public.user_roles
  FOR DELETE TO authenticated
  USING (public.has_role('admin'));