CREATE TABLE public.log_reconciliation_runs (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  ran_at timestamptz NOT NULL DEFAULT now(),
  provisioned_inserted integer NOT NULL DEFAULT 0,
  sms_inbound_inserted integer NOT NULL DEFAULT 0,
  missed_call_inserted integer NOT NULL DEFAULT 0,
  duration_ms integer NOT NULL DEFAULT 0,
  detail text,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.log_reconciliation_runs TO authenticated;
GRANT ALL ON public.log_reconciliation_runs TO service_role;

ALTER TABLE public.log_reconciliation_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can view reconciliation runs"
  ON public.log_reconciliation_runs FOR SELECT TO authenticated
  USING (public.has_role('admin'));

CREATE INDEX idx_log_reconciliation_runs_ran_at ON public.log_reconciliation_runs (ran_at DESC);

CREATE OR REPLACE FUNCTION public.reconcile_activity_logs()
RETURNS TABLE(provisioned_inserted integer, sms_inbound_inserted integer, missed_call_inserted integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _start timestamptz := clock_timestamp();
  _prov integer := 0;
  _sms integer := 0;
  _call integer := 0;
BEGIN
  -- 1) number_provisioned entries for businesses with a provisioned Twilio number.
  WITH ins AS (
    INSERT INTO public.logs (user_id, action_type, status, message_sent, created_at)
    SELECT p.id, 'number_provisioned', 'reconciled',
           'Reconciled from profile provisioning record: ' || coalesce(p.twilio_phone_number, p.twilio_phone_sid),
           coalesce(p.twilio_provisioned_at, now())
    FROM public.profiles p
    WHERE p.twilio_phone_sid IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.logs l
        WHERE l.user_id = p.id AND l.action_type = 'number_provisioned')
      AND NOT EXISTS (
        SELECT 1 FROM public.logs_archive a
        WHERE a.user_id = p.id AND a.action_type = 'number_provisioned')
    RETURNING 1)
  SELECT count(*)::int INTO _prov FROM ins;

  -- 2) sms_inbound entries for verified inbound-SMS webhooks missing a log row.
  WITH src AS (
    SELECT w.user_id,
           nullif(w.payload->>'MessageSid', '') AS sid,
           nullif(w.payload->>'Body', '') AS body,
           w.from_number,
           w.received_at
    FROM public.webhook_events w
    WHERE w.source = 'twilio'
      AND w.event_kind = 'sms_inbound'
      AND w.signature_valid
      AND w.user_id IS NOT NULL
      AND nullif(w.payload->>'MessageSid', '') IS NOT NULL
  ), ins AS (
    INSERT INTO public.logs (user_id, customer_id, action_type, status, message_sent, twilio_message_sid, recipient_phone, created_at)
    SELECT s.user_id,
           (SELECT c.id FROM public.customers c
             WHERE c.user_id = s.user_id AND c.phone_number = s.from_number LIMIT 1),
           'sms_inbound', 'reconciled', s.body, s.sid, s.from_number, s.received_at
    FROM src s
    WHERE NOT EXISTS (
        SELECT 1 FROM public.logs l
        WHERE l.action_type = 'sms_inbound' AND l.twilio_message_sid = s.sid)
      AND NOT EXISTS (
        SELECT 1 FROM public.logs_archive a
        WHERE a.action_type = 'sms_inbound' AND a.twilio_message_sid = s.sid)
    RETURNING 1)
  SELECT count(*)::int INTO _sms FROM ins;

  -- 3) missed_call entries for verified missed-call webhooks with no nearby missed-call log.
  WITH src AS (
    SELECT w.user_id, w.from_number, w.received_at,
           nullif(w.payload->>'CallSid', '') AS call_sid
    FROM public.webhook_events w
    WHERE w.source = 'twilio'
      AND w.event_kind = 'missed_call'
      AND w.signature_valid
      AND w.user_id IS NOT NULL
  ), ins AS (
    INSERT INTO public.logs (user_id, customer_id, action_type, status, message_sent, call_sid, recipient_phone, created_at)
    SELECT s.user_id,
           (SELECT c.id FROM public.customers c
             WHERE c.user_id = s.user_id AND c.phone_number = s.from_number LIMIT 1),
           'missed_call_text', 'reconciled',
           'Reconciled from missed-call webhook record', s.call_sid, s.from_number, s.received_at
    FROM src s
    WHERE NOT EXISTS (
        SELECT 1 FROM public.logs l
        WHERE l.user_id = s.user_id
          AND l.action_type IN ('missed_call_text','missed_call_autotext','missed_call_excluded','voicemail_notify')
          AND (
            (s.call_sid IS NOT NULL AND l.call_sid = s.call_sid)
            OR l.created_at BETWEEN s.received_at - interval '10 minutes' AND s.received_at + interval '10 minutes'
          ))
      AND NOT EXISTS (
        SELECT 1 FROM public.logs_archive a
        WHERE a.user_id = s.user_id
          AND a.action_type IN ('missed_call_text','missed_call_autotext','missed_call_excluded','voicemail_notify')
          AND (
            (s.call_sid IS NOT NULL AND a.call_sid = s.call_sid)
            OR a.original_created_at BETWEEN s.received_at - interval '10 minutes' AND s.received_at + interval '10 minutes'
          ))
    RETURNING 1)
  SELECT count(*)::int INTO _call FROM ins;

  INSERT INTO public.log_reconciliation_runs (
    provisioned_inserted, sms_inbound_inserted, missed_call_inserted, duration_ms)
  VALUES (_prov, _sms, _call,
    greatest(0, (extract(epoch FROM clock_timestamp() - _start) * 1000)::int));

  RETURN QUERY SELECT _prov, _sms, _call;
END;
$$;

-- Keep run history bounded.
CREATE OR REPLACE FUNCTION public.log_reconciliation_runs_prune()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  DELETE FROM public.log_reconciliation_runs
  WHERE ran_at < now() - interval '90 days';
$$;

SELECT cron.schedule(
  'reconcile-activity-logs-hourly',
  '17 * * * *',
  $$ SELECT public.reconcile_activity_logs(); SELECT public.log_reconciliation_runs_prune(); $$
);