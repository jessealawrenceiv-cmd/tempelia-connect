ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS stripe_connect_account_id text,
  ADD COLUMN IF NOT EXISTS stripe_connect_status text NOT NULL DEFAULT 'not_available',
  ADD COLUMN IF NOT EXISTS platform_fee_percent numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS stripe_connect_connected_at timestamptz;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_stripe_connect_status_check
  CHECK (stripe_connect_status IN ('not_available','not_connected','pending','connected','disabled'));

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_platform_fee_percent_check
  CHECK (platform_fee_percent >= 0 AND platform_fee_percent <= 100);