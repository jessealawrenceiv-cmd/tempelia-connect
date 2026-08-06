ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS auto_refresh_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS auto_refresh_interval_minutes integer NOT NULL DEFAULT 15
    CONSTRAINT profiles_auto_refresh_interval_minutes_check
    CHECK (auto_refresh_interval_minutes BETWEEN 1 AND 120);