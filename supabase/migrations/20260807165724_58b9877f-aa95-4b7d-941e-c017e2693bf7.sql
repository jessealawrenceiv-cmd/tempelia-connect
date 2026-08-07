-- Backend-side dedupe guard for the Activity log ingestion path.
-- Webhook handlers already claim each provider delivery, but that claim can fail
-- open (bookkeeping error) or race across concurrent workers. A unique key on the
-- row itself makes a duplicate row impossible at the storage layer.
ALTER TABLE public.logs ADD COLUMN IF NOT EXISTS dedupe_key text;

COMMENT ON COLUMN public.logs.dedupe_key IS
  'Idempotency key for ingested events (e.g. "voice:CAxxxx:completed|missed_call_autotext"). '
  'NULL for rows with no natural key. Unique per user_id when set.';

-- Partial unique index: only keyed (ingested) rows participate, so ordinary
-- app-generated log rows keep inserting freely.
CREATE UNIQUE INDEX IF NOT EXISTS logs_user_dedupe_key_unique
  ON public.logs (user_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;