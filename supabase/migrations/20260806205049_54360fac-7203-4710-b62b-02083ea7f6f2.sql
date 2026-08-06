-- 1) Archive table for older activity log rows
CREATE TABLE public.logs_archive (
  id uuid NOT NULL PRIMARY KEY,
  user_id uuid NOT NULL,
  customer_id uuid,
  action_type text NOT NULL,
  status text NOT NULL,
  message_sent text,
  twilio_message_sid text,
  voicemail_url text,
  recording_sid text,
  call_sid text,
  prompt_template text,
  prompt_template_hash text,
  prompt_cooldown_minutes integer,
  recipient_phone text,
  original_created_at timestamptz NOT NULL,
  archived_at timestamptz NOT NULL DEFAULT now(),
  archive_reason text NOT NULL DEFAULT 'age',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX logs_archive_user_created_idx
  ON public.logs_archive (user_id, original_created_at DESC);
CREATE INDEX logs_archive_archived_at_idx
  ON public.logs_archive (archived_at DESC);

GRANT SELECT ON public.logs_archive TO authenticated;
GRANT ALL ON public.logs_archive TO service_role;

ALTER TABLE public.logs_archive ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owners read their archived activity"
  ON public.logs_archive FOR SELECT TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "Team members read business archived activity"
  ON public.logs_archive FOR SELECT TO authenticated
  USING (public.is_accepted_team_member(user_id));

CREATE POLICY "Admins read all archived activity"
  ON public.logs_archive FOR SELECT TO authenticated
  USING (public.has_role('admin'));

-- 2) Retention run history
CREATE TABLE public.log_retention_runs (
  id uuid NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  ran_at timestamptz NOT NULL DEFAULT now(),
  archived_age_count integer NOT NULL DEFAULT 0,
  archived_cap_count integer NOT NULL DEFAULT 0,
  purged_archive_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.log_retention_runs TO authenticated;
GRANT ALL ON public.log_retention_runs TO service_role;

ALTER TABLE public.log_retention_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins read log retention runs"
  ON public.log_retention_runs FOR SELECT TO authenticated
  USING (public.has_role('admin'));

-- 3) Retention routine: archive by age, then cap per user, then purge old archive rows
CREATE OR REPLACE FUNCTION public.archive_old_logs(
  _max_age interval DEFAULT '90 days'::interval,
  _keep_per_user integer DEFAULT 5000,
  _archive_max_age interval DEFAULT '2 years'::interval
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  a_age integer := 0;
  a_cap integer := 0;
  purged integer := 0;
BEGIN
  WITH doomed AS (
    DELETE FROM public.logs l
     WHERE l.created_at < now() - _max_age
    RETURNING l.*
  ), moved AS (
    INSERT INTO public.logs_archive (
      id, user_id, customer_id, action_type, status, message_sent,
      twilio_message_sid, voicemail_url, recording_sid, call_sid,
      prompt_template, prompt_template_hash, prompt_cooldown_minutes,
      recipient_phone, original_created_at, archive_reason
    )
    SELECT d.id, d.user_id, d.customer_id, d.action_type, d.status, d.message_sent,
           d.twilio_message_sid, d.voicemail_url, d.recording_sid, d.call_sid,
           d.prompt_template, d.prompt_template_hash, d.prompt_cooldown_minutes,
           d.recipient_phone, d.created_at, 'age'
      FROM doomed d
    ON CONFLICT (id) DO NOTHING
    RETURNING 1
  ) SELECT count(*) INTO a_age FROM moved;

  WITH ranked AS (
    SELECT id, row_number() OVER (PARTITION BY user_id ORDER BY created_at DESC, id DESC) AS rn
      FROM public.logs
  ), doomed AS (
    DELETE FROM public.logs l
     USING ranked r
     WHERE l.id = r.id AND r.rn > _keep_per_user
    RETURNING l.*
  ), moved AS (
    INSERT INTO public.logs_archive (
      id, user_id, customer_id, action_type, status, message_sent,
      twilio_message_sid, voicemail_url, recording_sid, call_sid,
      prompt_template, prompt_template_hash, prompt_cooldown_minutes,
      recipient_phone, original_created_at, archive_reason
    )
    SELECT d.id, d.user_id, d.customer_id, d.action_type, d.status, d.message_sent,
           d.twilio_message_sid, d.voicemail_url, d.recording_sid, d.call_sid,
           d.prompt_template, d.prompt_template_hash, d.prompt_cooldown_minutes,
           d.recipient_phone, d.created_at, 'cap'
      FROM doomed d
    ON CONFLICT (id) DO NOTHING
    RETURNING 1
  ) SELECT count(*) INTO a_cap FROM moved;

  WITH gone AS (
    DELETE FROM public.logs_archive
     WHERE original_created_at < now() - _archive_max_age
    RETURNING 1
  ) SELECT count(*) INTO purged FROM gone;

  INSERT INTO public.log_retention_runs
    (archived_age_count, archived_cap_count, purged_archive_count)
  VALUES (a_age, a_cap, purged);

  RETURN a_age + a_cap;
END;
$$;

-- 4) Nightly schedule
CREATE EXTENSION IF NOT EXISTS pg_cron;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'archive-old-activity-logs') THEN
    PERFORM cron.unschedule('archive-old-activity-logs');
  END IF;
END $$;

SELECT cron.schedule(
  'archive-old-activity-logs',
  '20 3 * * *',
  $$SELECT public.archive_old_logs();$$
);
