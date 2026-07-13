CREATE OR REPLACE FUNCTION public.quotes_validate_total_consistency()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  items_sum numeric;
  expected numeric;
BEGIN
  SELECT COALESCE(sum((e->>'amount')::numeric), 0)
    INTO items_sum
    FROM jsonb_array_elements(NEW.line_items) e;
  expected := items_sum + COALESCE(NEW.tax_amount, 0);
  IF abs(COALESCE(NEW.total_amount, 0) - expected) > 0.01 THEN
    RAISE EXCEPTION 'quotes.total_amount (%) does not match sum(line_items)=% + tax_amount=% (expected %, tolerance 0.01)',
      NEW.total_amount, items_sum, NEW.tax_amount, expected
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS quotes_validate_total_consistency_trg ON public.quotes;
CREATE TRIGGER quotes_validate_total_consistency_trg
BEFORE INSERT OR UPDATE ON public.quotes
FOR EACH ROW EXECUTE FUNCTION public.quotes_validate_total_consistency();