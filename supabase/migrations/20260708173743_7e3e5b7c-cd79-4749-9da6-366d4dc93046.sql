-- Extend the existing signup handler to grant admin to the first user only.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  existing_count int;
BEGIN
  INSERT INTO public.profiles (id, email, business_name, tos_accepted_at)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'business_name', ''),
    CASE WHEN (NEW.raw_user_meta_data->>'tos_accepted')::boolean THEN now() ELSE NULL END
  );

  SELECT count(*) INTO existing_count FROM public.user_roles;
  IF existing_count = 0 THEN
    INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'admin');
  END IF;

  RETURN NEW;
END;
$$;

-- Ensure the trigger is wired up (idempotent).
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();