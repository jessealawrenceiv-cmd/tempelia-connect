ALTER TABLE public.webhook_events
  ADD COLUMN IF NOT EXISTS correlated_log_id uuid REFERENCES public.logs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS correlation_state text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS correlated_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS correlation_detail text;

ALTER TABLE public.webhook_events
  DROP CONSTRAINT IF EXISTS webhook_events_correlation_state_check;
ALTER TABLE public.webhook_events
  ADD CONSTRAINT webhook_events_correlation_state_check
  CHECK (correlation_state IN ('pending','correlated','missing','not_applicable'));

CREATE INDEX IF NOT EXISTS webhook_events_correlation_pending_idx
  ON public.webhook_events (event_kind, correlation_state, received_at DESC);

CREATE TABLE IF NOT EXISTS public.webhook_correlation_runs (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  ran_at timestamp with time zone NOT NULL DEFAULT now(),
  correlated_count integer NOT NULL DEFAULT 0,
  missing_count integer NOT NULL DEFAULT 0,
  not_applicable_count integer NOT NULL DEFAULT 0,
  duration_ms integer NOT NULL DEFAULT 0,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

GRANT SELECT ON public.webhook_correlation_runs TO authenticated;
GRANT ALL ON public.webhook_correlation_runs TO service_role;

ALTER TABLE public.webhook_correlation_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can view webhook correlation runs" ON public.webhook_correlation_runs;
CREATE POLICY "Admins can view webhook correlation runs"
  ON public.webhook_correlation_runs FOR SELECT TO authenticated
  USING (public.has_role('admin'));

CREATE OR REPLACE FUNCTION public.flag_missed_call_correlation_failures(_grace interval DEFAULT '5 minutes'::interval)
RETURNS TABLE(correlated_count integer, missing_count integer, not_applicable_count integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _start timestamptz := clock_timestamp();
  _ok integer := 0;
  _missing integer := 0;
  _na integer := 0;
BEGIN
  -- Events we can never correlate: rejected signatures or hits we could not
  -- attribute to a tenant. Park them so they stop being retried forever.
  WITH upd AS (
    UPDATE public.webhook_events w
       SET correlation_state = 'not_applicable',
           correlated_at = now(),
           correlation_detail = CASE
             WHEN NOT w.signature_valid THEN 'Signature rejected — no processing expected'
             ELSE 'Could not attribute the call to a business number'
           END
     WHERE w.event_kind = 'missed_call'
       AND w.correlation_state = 'pending'
       AND (NOT w.signature_valid OR w.user_id IS NULL)
    RETURNING 1)
  SELECT count(*)::int INTO _na FROM upd;

  -- Link each verified missed call to the activity entry it produced: exact
  -- CallSid match first, otherwise the nearest missed-call entry for the same
  -- business and caller inside a 10-minute window.
  WITH candidates AS (
    SELECT w.id AS event_id,
           (SELECT l.id
              FROM public.logs l
             WHERE l.user_id = w.user_id
               AND l.action_type IN ('missed_call_text','missed_call_autotext','missed_call_excluded','voicemail_notify')
               AND (
                 (nullif(w.payload->>'CallSid','') IS NOT NULL AND l.call_sid = nullif(w.payload->>'CallSid',''))
                 OR (
                   l.call_sid IS NULL
                   AND (l.recipient_phone IS NULL OR w.from_number IS NULL OR l.recipient_phone = w.from_number)
                   AND l.created_at BETWEEN w.received_at - interval '10 minutes'
                                        AND w.received_at + interval '10 minutes'
                 )
               )
             ORDER BY abs(extract(epoch FROM l.created_at - w.received_at))
             LIMIT 1) AS log_id
      FROM public.webhook_events w
     WHERE w.event_kind = 'missed_call'
       AND w.correlation_state = 'pending'
       AND w.signature_valid
       AND w.user_id IS NOT NULL
  ), upd AS (
    UPDATE public.webhook_events w
       SET correlated_log_id = c.log_id,
           correlation_state = 'correlated',
           correlated_at = now(),
           correlation_detail = 'Matched the activity entry produced by this call'
      FROM candidates c
     WHERE w.id = c.event_id AND c.log_id IS NOT NULL
    RETURNING 1)
  SELECT count(*)::int INTO _ok FROM upd;

  -- Anything still pending past the grace period produced no activity entry:
  -- flag it and surface the failure in the owner's Activity log.
  WITH doomed AS (
    UPDATE public.webhook_events w
       SET correlation_state = 'missing',
           correlated_at = now(),
           correlation_detail = 'No activity entry found for this missed call'
     WHERE w.event_kind = 'missed_call'
       AND w.correlation_state = 'pending'
       AND w.signature_valid
       AND w.user_id IS NOT NULL
       AND w.received_at < now() - _grace
    RETURNING w.id, w.user_id, w.from_number, w.received_at, w.payload
  ), logged AS (
    INSERT INTO public.logs (user_id, action_type, status, message_sent, call_sid, recipient_phone, created_at)
    SELECT d.user_id, 'webhook_delivery_status', 'correlation_missing',
           jsonb_build_object(
             'event_kind', 'missed_call',
             'outcome', 'correlation_missing',
             'webhook_event_id', d.id,
             'call_sid', nullif(d.payload->>'CallSid',''),
             'from', d.from_number,
             'received_at', d.received_at,
             'note', 'A verified missed-call webhook arrived but no matching activity entry was created.',
             'at', now()
           )::text,
           nullif(d.payload->>'CallSid',''), d.from_number, now()
      FROM doomed d
    RETURNING 1)
  SELECT count(*)::int INTO _missing FROM logged;

  INSERT INTO public.webhook_correlation_runs
    (correlated_count, missing_count, not_applicable_count, duration_ms)
  VALUES (_ok, _missing, _na,
    greatest(0, (extract(epoch FROM clock_timestamp() - _start) * 1000)::int));

  RETURN QUERY SELECT _ok, _missing, _na;
END;
$$;

REVOKE ALL ON FUNCTION public.flag_missed_call_correlation_failures(interval) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.flag_missed_call_correlation_failures(interval) TO service_role;

CREATE OR REPLACE FUNCTION public.webhook_correlation_runs_prune()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  DELETE FROM public.webhook_correlation_runs WHERE ran_at < now() - interval '90 days';
$$;

REVOKE ALL ON FUNCTION public.webhook_correlation_runs_prune() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.webhook_correlation_runs_prune() TO service_role;

SELECT cron.unschedule('missed-call-correlation-check')
 WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'missed-call-correlation-check');

SELECT cron.schedule(
  'missed-call-correlation-check',
  '*/15 * * * *',
  $$SELECT public.flag_missed_call_correlation_failures(); SELECT public.webhook_correlation_runs_prune();$$
);