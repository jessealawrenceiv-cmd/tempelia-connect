CREATE OR REPLACE FUNCTION public.profiles_validate_opt_in_prompt()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  tpl text;
  tok text;
BEGIN
  IF NEW.opt_in_prompt_cooldown_minutes IS NULL
     OR NEW.opt_in_prompt_cooldown_minutes < 5
     OR NEW.opt_in_prompt_cooldown_minutes > 1440 THEN
    RAISE EXCEPTION 'opt_in_prompt_cooldown_minutes must be between 5 and 1440'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.opt_in_prompt_template IS NOT NULL AND btrim(NEW.opt_in_prompt_template) = '' THEN
    NEW.opt_in_prompt_template := NULL;
  END IF;

  tpl := btrim(coalesce(NEW.opt_in_prompt_template, ''));

  IF length(tpl) > 300 THEN
    RAISE EXCEPTION 'opt_in_prompt_template must be 300 characters or fewer'
      USING ERRCODE = 'check_violation';
  END IF;

  IF tpl <> '' THEN
    -- every {...} token must be exactly {business}
    FOR tok IN SELECT m[1] FROM regexp_matches(tpl, '\{[^{}]*\}', 'g') AS m LOOP
      IF tok <> '{business}' THEN
        IF lower(btrim(tok, '{} ')) = 'business' THEN
          RAISE EXCEPTION 'opt_in_prompt_template placeholder must be written exactly as {business} (lowercase, no spaces); got %', tok
            USING ERRCODE = 'check_violation';
        ELSE
          RAISE EXCEPTION 'opt_in_prompt_template contains unsupported placeholder %; only {business} is available', tok
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;
    END LOOP;

    -- no stray braces left after removing valid tokens
    IF regexp_replace(tpl, '\{[^{}]*\}', '', 'g') ~ '[{}]' THEN
      RAISE EXCEPTION 'opt_in_prompt_template has unbalanced braces; write the placeholder exactly as {business}'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;