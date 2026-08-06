CREATE OR REPLACE FUNCTION public.quotes_audit_deposit_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  actor uuid := auth.uid();
  actor_em text;
  prev_required boolean;
  prev_amount numeric;
  prev_paid boolean;
  prev_paid_at timestamptz;
  new_amount numeric := COALESCE(NEW.deposit_amount, 0);
  st text;
  src text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Only audit inserts that already carry deposit state (e.g. quote revisions).
    IF NOT NEW.deposit_required AND new_amount = 0 AND NOT NEW.deposit_paid THEN
      RETURN NEW;
    END IF;
    prev_required := NULL;
    prev_amount := NULL;
    prev_paid := NULL;
    prev_paid_at := NULL;
    src := 'quote_insert';
  ELSE
    IF OLD.deposit_required IS NOT DISTINCT FROM NEW.deposit_required
       AND COALESCE(OLD.deposit_amount, 0) IS NOT DISTINCT FROM new_amount
       AND OLD.deposit_paid IS NOT DISTINCT FROM NEW.deposit_paid THEN
      RETURN NEW;
    END IF;
    prev_required := OLD.deposit_required;
    prev_amount := COALESCE(OLD.deposit_amount, 0);
    prev_paid := OLD.deposit_paid;
    prev_paid_at := OLD.deposit_paid_at;
    src := 'quote_edit';
  END IF;

  IF actor IS NOT NULL THEN
    SELECT u.email INTO actor_em FROM auth.users u WHERE u.id = actor;
  END IF;

  IF NEW.deposit_paid AND COALESCE(prev_paid, false) = false THEN
    st := 'deposit_received';
  ELSIF NOT NEW.deposit_paid AND COALESCE(prev_paid, false) = true THEN
    st := 'deposit_undone';
  ELSIF NOT NEW.deposit_required AND COALESCE(prev_required, false) = true THEN
    st := 'deposit_removed';
  ELSE
    st := 'deposit_changed';
  END IF;

  INSERT INTO public.logs (user_id, customer_id, action_type, status, message_sent)
  VALUES (
    NEW.user_id,
    NEW.customer_id,
    'quote_deposit_status',
    st,
    jsonb_build_object(
      'quote_id', NEW.id,
      'source', src,
      'actor_user_id', actor,
      'actor_email', actor_em,
      'actor_is_owner', (actor IS NOT NULL AND actor = NEW.user_id),
      'deposit_amount', new_amount,
      'total_amount', COALESCE(NEW.total_amount, 0),
      'balance_remaining', round(COALESCE(NEW.total_amount, 0) - (CASE WHEN NEW.deposit_paid THEN new_amount ELSE 0 END), 2),
      'previous_required', prev_required,
      'previous_amount', prev_amount,
      'previous_paid', prev_paid,
      'previous_paid_at', prev_paid_at,
      'new_required', NEW.deposit_required,
      'new_paid', NEW.deposit_paid,
      'new_paid_at', NEW.deposit_paid_at,
      'at', now()
    )::text
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS quotes_audit_deposit_change_trg ON public.quotes;
CREATE TRIGGER quotes_audit_deposit_change_trg
AFTER INSERT OR UPDATE ON public.quotes
FOR EACH ROW EXECUTE FUNCTION public.quotes_audit_deposit_change();