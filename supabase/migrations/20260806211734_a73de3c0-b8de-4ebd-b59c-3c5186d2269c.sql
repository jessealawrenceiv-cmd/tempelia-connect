-- 1) Per-business invoice number counter
CREATE TABLE public.invoice_counters (
  user_id uuid NOT NULL PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  next_seq integer NOT NULL DEFAULT 1001,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.invoice_counters TO authenticated;
GRANT ALL ON public.invoice_counters TO service_role;
ALTER TABLE public.invoice_counters ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users read their own invoice counter" ON public.invoice_counters
  FOR SELECT TO authenticated USING (auth.uid() = user_id OR public.is_accepted_team_member(user_id));

-- 2) Invoices
CREATE TABLE public.invoices (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  quote_id uuid REFERENCES public.quotes(id) ON DELETE SET NULL,
  customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  invoice_seq integer NOT NULL,
  invoice_number text NOT NULL,
  customer_first_name text NOT NULL,
  customer_last_name text,
  customer_business_name text,
  customer_phone text NOT NULL,
  customer_email text,
  job_site_address text NOT NULL,
  line_items jsonb NOT NULL DEFAULT '[]'::jsonb,
  subtotal numeric NOT NULL DEFAULT 0,
  tax_rate numeric NOT NULL DEFAULT 0,
  tax_amount numeric NOT NULL DEFAULT 0,
  total_amount numeric NOT NULL DEFAULT 0,
  deposit_amount numeric NOT NULL DEFAULT 0,
  deposit_paid boolean NOT NULL DEFAULT false,
  balance_due numeric GENERATED ALWAYS AS (
    round(total_amount - (CASE WHEN deposit_paid THEN deposit_amount ELSE 0 END), 2)
  ) STORED,
  status text NOT NULL DEFAULT 'draft',
  superseded_by_id uuid REFERENCES public.invoices(id) ON DELETE SET NULL,
  balance_paid_at timestamptz,
  sent_at timestamptz,
  archived_at timestamptz,
  last_sms_sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invoices_status_chk CHECK (status IN ('draft','sent','paid','archived')),
  CONSTRAINT invoices_seq_unique UNIQUE (user_id, invoice_seq),
  CONSTRAINT invoices_number_unique UNIQUE (user_id, invoice_number)
);
CREATE INDEX invoices_user_created_idx ON public.invoices (user_id, created_at DESC);
CREATE INDEX invoices_quote_idx ON public.invoices (quote_id);

GRANT SELECT, INSERT, UPDATE ON public.invoices TO authenticated;
GRANT ALL ON public.invoices TO service_role;
ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own invoices" ON public.invoices
  FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Accepted staff access invoices" ON public.invoices
  FOR ALL TO authenticated
  USING (public.is_accepted_team_member(user_id))
  WITH CHECK (public.is_accepted_team_member(user_id));

CREATE TRIGGER invoices_set_updated_at BEFORE UPDATE ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 3) Gapless, per-business numbering assigned by the database
CREATE OR REPLACE FUNCTION public.invoices_assign_number()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  n integer;
BEGIN
  INSERT INTO public.invoice_counters (user_id, next_seq)
  VALUES (NEW.user_id, 1001)
  ON CONFLICT (user_id) DO UPDATE
    SET next_seq = public.invoice_counters.next_seq + 1,
        updated_at = now()
  RETURNING next_seq INTO n;

  NEW.invoice_seq := n;
  NEW.invoice_number := 'INV-' || n::text;
  RETURN NEW;
END;
$$;

CREATE TRIGGER invoices_assign_number_trg BEFORE INSERT ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.invoices_assign_number();

-- 4) Immutability: numbers never change; sent/paid/archived invoices are never
--    edited in place (only status/supersede/tracking columns may move).
CREATE OR REPLACE FUNCTION public.invoices_enforce_immutability()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.invoice_seq IS DISTINCT FROM OLD.invoice_seq
     OR NEW.invoice_number IS DISTINCT FROM OLD.invoice_number THEN
    RAISE EXCEPTION 'invoice_number and owner are permanent and cannot be changed'
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.status <> 'draft' THEN
    IF NEW.customer_first_name IS DISTINCT FROM OLD.customer_first_name
       OR NEW.customer_last_name IS DISTINCT FROM OLD.customer_last_name
       OR NEW.customer_business_name IS DISTINCT FROM OLD.customer_business_name
       OR NEW.customer_phone IS DISTINCT FROM OLD.customer_phone
       OR NEW.customer_email IS DISTINCT FROM OLD.customer_email
       OR NEW.job_site_address IS DISTINCT FROM OLD.job_site_address
       OR NEW.line_items IS DISTINCT FROM OLD.line_items
       OR NEW.subtotal IS DISTINCT FROM OLD.subtotal
       OR NEW.tax_rate IS DISTINCT FROM OLD.tax_rate
       OR NEW.tax_amount IS DISTINCT FROM OLD.tax_amount
       OR NEW.total_amount IS DISTINCT FROM OLD.total_amount
       OR NEW.deposit_amount IS DISTINCT FROM OLD.deposit_amount THEN
      RAISE EXCEPTION 'invoice % is % — it cannot be edited in place; create a revision instead',
        OLD.invoice_number, OLD.status USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW.status = 'paid' AND NEW.balance_paid_at IS NULL THEN
    NEW.balance_paid_at := now();
  END IF;
  IF NEW.status <> 'paid' AND OLD.status = 'paid' THEN
    NEW.balance_paid_at := NULL;
  END IF;
  IF NEW.status = 'sent' AND NEW.sent_at IS NULL THEN
    NEW.sent_at := now();
  END IF;
  IF NEW.status = 'archived' AND NEW.archived_at IS NULL THEN
    NEW.archived_at := now();
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER invoices_enforce_immutability_trg BEFORE UPDATE ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.invoices_enforce_immutability();

-- Never deletable: permanent numbered record.
CREATE OR REPLACE FUNCTION public.invoices_block_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'invoices are permanent records and cannot be deleted; archive instead'
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER invoices_block_delete_trg BEFORE DELETE ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.invoices_block_delete();

-- 5) Total consistency, same rigor as quotes
CREATE OR REPLACE FUNCTION public.invoices_validate_totals()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  items_sum numeric;
  expected numeric;
BEGIN
  SELECT COALESCE(sum((e->>'amount')::numeric), 0) INTO items_sum
    FROM jsonb_array_elements(NEW.line_items) e;
  expected := items_sum + COALESCE(NEW.tax_amount, 0);
  IF abs(COALESCE(NEW.total_amount, 0) - expected) > 0.01 THEN
    RAISE EXCEPTION 'invoices.total_amount (%) does not match sum(line_items)=% + tax_amount=% (expected %)',
      NEW.total_amount, items_sum, NEW.tax_amount, expected USING ERRCODE = 'check_violation';
  END IF;
  IF COALESCE(NEW.deposit_amount, 0) < 0
     OR COALESCE(NEW.deposit_amount, 0) > COALESCE(NEW.total_amount, 0) + 0.01 THEN
    RAISE EXCEPTION 'invoices.deposit_amount (%) must be between 0 and the invoice total (%)',
      NEW.deposit_amount, NEW.total_amount USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER invoices_validate_totals_trg BEFORE INSERT OR UPDATE ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.invoices_validate_totals();

-- 6) Audit every balance-received change, same pattern as deposits
CREATE OR REPLACE FUNCTION public.invoices_audit_balance_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  actor uuid := auth.uid();
  actor_em text;
  st text;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status IS NOT DISTINCT FROM NEW.status THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' AND NEW.status = 'draft' THEN
    RETURN NEW;
  END IF;

  IF actor IS NOT NULL THEN
    SELECT u.email INTO actor_em FROM auth.users u WHERE u.id = actor;
  END IF;

  st := CASE
    WHEN NEW.status = 'paid' THEN 'balance_received'
    WHEN TG_OP = 'UPDATE' AND OLD.status = 'paid' THEN 'balance_undone'
    WHEN NEW.status = 'archived' THEN 'invoice_archived'
    WHEN NEW.status = 'sent' THEN 'invoice_sent'
    ELSE 'invoice_status_changed'
  END;

  INSERT INTO public.logs (user_id, customer_id, action_type, status, message_sent)
  VALUES (
    NEW.user_id, NEW.customer_id, 'invoice_balance_status', st,
    jsonb_build_object(
      'invoice_id', NEW.id,
      'invoice_number', NEW.invoice_number,
      'quote_id', NEW.quote_id,
      'source', CASE WHEN TG_OP = 'INSERT' THEN 'invoice_insert' ELSE 'invoice_update' END,
      'actor_user_id', actor,
      'actor_email', actor_em,
      'actor_is_owner', (actor IS NOT NULL AND actor = NEW.user_id),
      'previous_status', CASE WHEN TG_OP = 'UPDATE' THEN OLD.status ELSE NULL END,
      'new_status', NEW.status,
      'previous_balance_due', CASE WHEN TG_OP = 'UPDATE' THEN OLD.balance_due ELSE NULL END,
      'new_balance_due', NEW.balance_due,
      'total_amount', NEW.total_amount,
      'deposit_amount', NEW.deposit_amount,
      'deposit_paid', NEW.deposit_paid,
      'previous_balance_paid_at', CASE WHEN TG_OP = 'UPDATE' THEN OLD.balance_paid_at ELSE NULL END,
      'new_balance_paid_at', NEW.balance_paid_at,
      'superseded_by_id', NEW.superseded_by_id,
      'at', now()
    )::text
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER invoices_audit_balance_change_trg AFTER INSERT OR UPDATE ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.invoices_audit_balance_change();