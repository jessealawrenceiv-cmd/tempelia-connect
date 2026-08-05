ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS opt_in_prompt_template text,
  ADD COLUMN IF NOT EXISTS opt_in_prompt_cooldown_minutes integer NOT NULL DEFAULT 60;

CREATE OR REPLACE FUNCTION public.profiles_validate_opt_in_prompt()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.opt_in_prompt_cooldown_minutes IS NULL
     OR NEW.opt_in_prompt_cooldown_minutes < 5
     OR NEW.opt_in_prompt_cooldown_minutes > 1440 THEN
    RAISE EXCEPTION 'opt_in_prompt_cooldown_minutes must be between 5 and 1440'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.opt_in_prompt_template IS NOT NULL AND length(NEW.opt_in_prompt_template) > 300 THEN
    RAISE EXCEPTION 'opt_in_prompt_template must be 300 characters or fewer'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.opt_in_prompt_template IS NOT NULL AND btrim(NEW.opt_in_prompt_template) = '' THEN
    NEW.opt_in_prompt_template := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profiles_validate_opt_in_prompt_trg ON public.profiles;
CREATE TRIGGER profiles_validate_opt_in_prompt_trg
BEFORE INSERT OR UPDATE ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.profiles_validate_opt_in_prompt();