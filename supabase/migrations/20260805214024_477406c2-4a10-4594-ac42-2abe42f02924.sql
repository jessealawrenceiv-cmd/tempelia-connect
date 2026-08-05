ALTER TABLE public.deposit_jump_recovery_events ADD COLUMN correlation_id text;
ALTER TABLE public.deposit_jump_debug_events ADD COLUMN correlation_id text;

CREATE INDEX deposit_jump_recovery_events_correlation_idx
  ON public.deposit_jump_recovery_events (correlation_id);
CREATE INDEX deposit_jump_debug_events_correlation_idx
  ON public.deposit_jump_debug_events (correlation_id);