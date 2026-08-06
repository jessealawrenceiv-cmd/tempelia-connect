ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS zip_code text;

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_zip_code_format;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_zip_code_format
  CHECK (zip_code IS NULL OR zip_code ~ '^[0-9]{5}$');