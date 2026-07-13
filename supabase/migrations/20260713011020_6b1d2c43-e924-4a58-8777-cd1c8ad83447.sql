
-- Extend customers with fields for the Contacts hub
ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS last_name text,
  ADD COLUMN IF NOT EXISTS email text,
  ADD COLUMN IF NOT EXISTS notes text,
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS sms_opt_in_at timestamptz,
  ADD COLUMN IF NOT EXISTS consent_form_signed boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS consent_form_signed_at timestamptz;

-- Dedupe key so intake submissions can upsert into an existing contact
CREATE UNIQUE INDEX IF NOT EXISTS customers_user_phone_uniq
  ON public.customers (user_id, phone_number);

-- Backfill sms_opt_in_at from existing opt_in_consent so filters work on legacy rows
UPDATE public.customers
   SET sms_opt_in_at = COALESCE(sms_opt_in_at, created_at)
 WHERE opt_in_consent = true AND sms_opt_in_at IS NULL;

-- Keep sms_opt_in_at in sync with opt_in_consent going forward
CREATE OR REPLACE FUNCTION public.sync_customer_sms_opt_in()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.opt_in_consent = true AND (OLD IS NULL OR OLD.opt_in_consent = false) THEN
    NEW.sms_opt_in_at := COALESCE(NEW.sms_opt_in_at, now());
  END IF;
  IF NEW.consent_form_signed = true AND (OLD IS NULL OR OLD.consent_form_signed = false) THEN
    NEW.consent_form_signed_at := COALESCE(NEW.consent_form_signed_at, now());
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_customer_sms_opt_in ON public.customers;
CREATE TRIGGER trg_sync_customer_sms_opt_in
  BEFORE INSERT OR UPDATE ON public.customers
  FOR EACH ROW EXECUTE FUNCTION public.sync_customer_sms_opt_in();
