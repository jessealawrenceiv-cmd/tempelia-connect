ALTER TABLE public.logs
  ADD COLUMN IF NOT EXISTS prompt_template text,
  ADD COLUMN IF NOT EXISTS prompt_template_hash text,
  ADD COLUMN IF NOT EXISTS prompt_cooldown_minutes integer;

COMMENT ON COLUMN public.logs.prompt_template IS 'Owner lead-in template in effect when this opt-in prompt was sent.';
COMMENT ON COLUMN public.logs.prompt_template_hash IS 'Short fingerprint (sha256 prefix) of the full rendered prompt body, for version comparison.';
COMMENT ON COLUMN public.logs.prompt_cooldown_minutes IS 'Per-contact cooldown setting in effect when this opt-in prompt was sent.';