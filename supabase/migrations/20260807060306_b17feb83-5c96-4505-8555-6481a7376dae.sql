ALTER TABLE public.log_reconciliation_runs
  ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'global',
  ADD COLUMN IF NOT EXISTS target_user_id uuid,
  ADD COLUMN IF NOT EXISTS target_action_type text,
  ADD COLUMN IF NOT EXISTS triggered_by uuid;

CREATE INDEX IF NOT EXISTS idx_log_reconciliation_runs_target
  ON public.log_reconciliation_runs (target_user_id, ran_at DESC);

CREATE OR REPLACE FUNCTION public.reconcile_activity_logs_scoped(
  _user_id uuid,
  _action_type text,
  _triggered_by uuid DEFAULT NULL
)
RETURNS TABLE(
  run_id uuid,
  inserted_count integer,
  duration_ms integer,
  supported boolean,
  detail text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _start timestamptz := clock_timestamp();
  _n integer := 0;
  _supported boolean := true;
  _detail text;
  _ms integer;
  _run uuid;
BEGIN
  IF _action_type = 'number_provisioned' THEN
    WITH ins AS (
      INSERT INTO public.logs (user_id, action_type, status, message_sent, created_at)
      SELECT p.id, 'number_provisioned', 'reconciled',
             'Reconciled from profile provisioning record: ' || coalesce(p.twilio_phone_number, p.twilio_phone_sid),
             coalesce(p.twilio_provisioned_at, now())
      FROM public.profiles p
      WHERE p.id = _user_id
        AND p.twilio_phone_sid IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM public.logs l
          WHERE l.user_id = p.id AND l.action_type = 'number_provisioned')
        AND NOT EXISTS (
          SELECT 1 FROM public.logs_archive a
          WHERE a.user_id = p.id AND a.action_type = 'number_provisioned')
      RETURNING 1)
    SELECT count(*)::int INTO _n FROM ins;
    _detail := 'Backfilled from public.profiles provisioning fields.';

  ELSIF _action_type = 'sms_inbound' THEN
    WITH src AS (
      SELECT w.user_id,
             nullif(w.payload->>'MessageSid', '') AS sid,
             nullif(w.payload->>'Body', '') AS body,
             w.from_number,
             w.received_at
      FROM public.webhook_events w
      WHERE w.user_id = _user_id
        AND w.source = 'twilio'
        AND w.event_kind = 'sms_inbound'
        AND w.signature_valid
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
    SELECT count(*)::int INTO _n FROM ins;
    _detail := 'Backfilled from verified inbound-SMS webhook events.';

  ELSIF _action_type IN ('missed_call_text', 'missed_call_autotext') THEN
    WITH src AS (
      SELECT w.user_id, w.from_number, w.received_at,
             nullif(w.payload->>'CallSid', '') AS call_sid
      FROM public.webhook_events w
      WHERE w.user_id = _user_id
        AND w.source = 'twilio'
        AND w.event_kind = 'missed_call'
        AND w.signature_valid
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
    SELECT count(*)::int INTO _n FROM ins;
    _detail := 'Backfilled from verified missed-call webhook events.';

  ELSE
    _supported := false;
    _detail := 'No backfill source exists for this action type - entries are only written live by the app.';
  END IF;

  _ms := greatest(0, (extract(epoch FROM clock_timestamp() - _start) * 1000)::int);

  INSERT INTO public.log_reconciliation_runs (
    provisioned_inserted, sms_inbound_inserted, missed_call_inserted, duration_ms,
    detail, scope, target_user_id, target_action_type, triggered_by)
  VALUES (
    CASE WHEN _action_type = 'number_provisioned' THEN _n ELSE 0 END,
    CASE WHEN _action_type = 'sms_inbound' THEN _n ELSE 0 END,
    CASE WHEN _action_type IN ('missed_call_text','missed_call_autotext') THEN _n ELSE 0 END,
    _ms, _detail, 'scoped', _user_id, _action_type, _triggered_by)
  RETURNING id INTO _run;

  RETURN QUERY SELECT _run, _n, _ms, _supported, _detail;
END;
$$;

REVOKE ALL ON FUNCTION public.reconcile_activity_logs_scoped(uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_activity_logs_scoped(uuid, text, uuid) TO service_role;