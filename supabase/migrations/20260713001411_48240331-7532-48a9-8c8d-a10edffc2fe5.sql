
-- 1) Intake enabled toggle
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS intake_enabled boolean NOT NULL DEFAULT true;

-- 2) Rate-limit table (server-side, service role only)
CREATE TABLE IF NOT EXISTS public.intake_rate_limits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  ip_hash text NOT NULL,
  submitted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS intake_rate_limits_lookup_idx
  ON public.intake_rate_limits (user_id, ip_hash, submitted_at DESC);
CREATE INDEX IF NOT EXISTS intake_rate_limits_submitted_at_idx
  ON public.intake_rate_limits (submitted_at);

-- service_role only; no anon/authenticated access
GRANT ALL ON public.intake_rate_limits TO service_role;
ALTER TABLE public.intake_rate_limits ENABLE ROW LEVEL SECURITY;
-- No policies = locked to service_role (which bypasses RLS)

-- 3) Revoke anonymous storage uploads. Uploads must go through the server fn
--    (service role), which enforces size + MIME + magic-byte checks.
DROP POLICY IF EXISTS "Anyone can upload intake photos" ON storage.objects;
