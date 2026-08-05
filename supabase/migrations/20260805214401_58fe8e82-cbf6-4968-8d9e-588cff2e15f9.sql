ALTER TABLE public.deposit_jump_recovery_events
  DROP CONSTRAINT deposit_jump_recovery_events_action_check;

ALTER TABLE public.deposit_jump_recovery_events
  ADD CONSTRAINT deposit_jump_recovery_events_action_check
  CHECK (action = ANY (ARRAY['return_to_top'::text, 'show_latest'::text, 'clear_filters'::text, 'dismiss'::text, 'retry_jump'::text]));

ALTER TABLE public.deposit_jump_recovery_events
  ADD COLUMN attempt_index integer,
  ADD COLUMN ms_since_first_miss integer;

ALTER TABLE public.deposit_jump_recovery_events
  ADD CONSTRAINT deposit_jump_recovery_events_attempt_index_check
  CHECK (attempt_index IS NULL OR attempt_index >= 0),
  ADD CONSTRAINT deposit_jump_recovery_events_ms_since_first_miss_check
  CHECK (ms_since_first_miss IS NULL OR ms_since_first_miss >= 0);