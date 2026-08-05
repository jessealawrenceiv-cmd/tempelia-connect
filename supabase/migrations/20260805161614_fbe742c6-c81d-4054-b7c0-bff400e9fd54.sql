ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS default_deposit_type text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS default_deposit_fixed_amount numeric,
  ADD COLUMN IF NOT EXISTS allow_deposit_override_per_quote boolean NOT NULL DEFAULT true;

ALTER TABLE public.quotes
  ADD COLUMN IF NOT EXISTS deposit_required boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS deposit_selection text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS deposit_custom_type text,
  ADD COLUMN IF NOT EXISTS deposit_custom_value numeric,
  ADD COLUMN IF NOT EXISTS deposit_amount numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS deposit_paid boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS deposit_paid_at timestamptz;

-- Resolve the expected deposit dollar amount for a given selection + total.
CREATE OR REPLACE FUNCTION public.resolve_deposit_amount(
  _selection text,
  _custom_type text,
  _custom_value numeric,
  _total numeric,
  _default_type text,
  _default_fixed numeric
) RETURNS numeric
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  t numeric := COALESCE(_total, 0);
BEGIN
  CASE lower(COALESCE(_selection, 'none'))
    WHEN 'none' THEN RETURN 0;
    WHEN 'percent_10' THEN RETURN round(t * 0.10, 2);
    WHEN 'percent_25' THEN RETURN round(t * 0.25, 2);
    WHEN 'percent_50' THEN RETURN round(t * 0.50, 2);
    WHEN 'full' THEN RETURN round(t, 2);
    WHEN 'custom' THEN
      IF _custom_type = 'percentage' THEN
        RETURN round(t * (COALESCE(_custom_value, 0) / 100.0), 2);
      ELSIF _custom_type = 'fixed' THEN
        RETURN round(COALESCE(_custom_value, 0), 2);
      ELSE
        RAISE EXCEPTION 'deposit_custom_type must be percentage or fixed when deposit_selection = custom'
          USING ERRCODE = 'check_violation';
      END IF;
    WHEN 'company_default' THEN
      CASE lower(COALESCE(_default_type, 'none'))
        WHEN 'none' THEN RETURN 0;
        WHEN 'percent_10' THEN RETURN round(t * 0.10, 2);
        WHEN 'percent_25' THEN RETURN round(t * 0.25, 2);
        WHEN 'percent_50' THEN RETURN round(t * 0.50, 2);
        WHEN 'full' THEN RETURN round(t, 2);
        WHEN 'fixed' THEN RETURN round(COALESCE(_default_fixed, 0), 2);
        ELSE
          RAISE EXCEPTION 'invalid profiles.default_deposit_type: %', _default_type
            USING ERRCODE = 'check_violation';
      END CASE;
    ELSE
      RAISE EXCEPTION 'invalid deposit_selection: %', _selection
        USING ERRCODE = 'check_violation';
  END CASE;
END;
$$;

CREATE OR REPLACE FUNCTION public.quotes_validate_deposit_consistency()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  def_type text;
  def_fixed numeric;
  expected numeric;
BEGIN
  IF NEW.deposit_selection IS NULL THEN NEW.deposit_selection := 'none'; END IF;

  IF NEW.deposit_selection NOT IN ('none','company_default','percent_10','percent_25','percent_50','custom','full') THEN
    RAISE EXCEPTION 'invalid deposit_selection: %', NEW.deposit_selection USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.deposit_custom_type IS NOT NULL AND NEW.deposit_custom_type NOT IN ('percentage','fixed') THEN
    RAISE EXCEPTION 'deposit_custom_type must be percentage or fixed' USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.deposit_selection <> 'custom' THEN
    NEW.deposit_custom_type := NULL;
    NEW.deposit_custom_value := NULL;
  ELSE
    IF NEW.deposit_custom_type IS NULL OR NEW.deposit_custom_value IS NULL THEN
      RAISE EXCEPTION 'custom deposits require deposit_custom_type and deposit_custom_value'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.deposit_custom_value < 0 THEN
      RAISE EXCEPTION 'deposit_custom_value cannot be negative' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NOT NEW.deposit_required THEN
    IF NEW.deposit_selection <> 'none' THEN
      RAISE EXCEPTION 'deposit_selection must be none when deposit_required is false'
        USING ERRCODE = 'check_violation';
    END IF;
    IF COALESCE(NEW.deposit_amount, 0) <> 0 THEN
      RAISE EXCEPTION 'deposit_amount must be 0 when deposit_required is false'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.deposit_paid THEN
      RAISE EXCEPTION 'deposit cannot be marked paid when no deposit is required'
        USING ERRCODE = 'check_violation';
    END IF;
    NEW.deposit_paid_at := NULL;
    RETURN NEW;
  END IF;

  IF NEW.deposit_selection = 'none' THEN
    RAISE EXCEPTION 'deposit_selection cannot be none when deposit_required is true'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT p.default_deposit_type, p.default_deposit_fixed_amount
    INTO def_type, def_fixed
    FROM public.profiles p WHERE p.id = NEW.user_id;

  expected := public.resolve_deposit_amount(
    NEW.deposit_selection, NEW.deposit_custom_type, NEW.deposit_custom_value,
    NEW.total_amount, def_type, def_fixed
  );

  IF abs(COALESCE(NEW.deposit_amount, 0) - expected) > 0.01 THEN
    RAISE EXCEPTION 'deposit_amount (%) is inconsistent with deposit_selection % on a total of % (expected %, tolerance 0.01)',
      NEW.deposit_amount, NEW.deposit_selection, NEW.total_amount, expected
      USING ERRCODE = 'check_violation';
  END IF;

  IF COALESCE(NEW.deposit_amount, 0) > COALESCE(NEW.total_amount, 0) + 0.01 THEN
    RAISE EXCEPTION 'deposit_amount (%) cannot exceed the quote total (%)',
      NEW.deposit_amount, NEW.total_amount USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.deposit_paid AND NEW.deposit_paid_at IS NULL THEN
    NEW.deposit_paid_at := now();
  END IF;
  IF NOT NEW.deposit_paid THEN
    NEW.deposit_paid_at := NULL;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS quotes_validate_deposit_consistency_trg ON public.quotes;
CREATE TRIGGER quotes_validate_deposit_consistency_trg
BEFORE INSERT OR UPDATE ON public.quotes
FOR EACH ROW EXECUTE FUNCTION public.quotes_validate_deposit_consistency();