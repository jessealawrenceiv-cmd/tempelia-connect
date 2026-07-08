CREATE TABLE public.excluded_numbers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  phone_number text NOT NULL,
  label text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, phone_number)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.excluded_numbers TO authenticated;
GRANT ALL ON public.excluded_numbers TO service_role;

ALTER TABLE public.excluded_numbers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own excluded numbers"
  ON public.excluded_numbers FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX idx_excluded_numbers_user_phone ON public.excluded_numbers (user_id, phone_number);

CREATE TRIGGER set_excluded_numbers_updated_at
  BEFORE UPDATE ON public.excluded_numbers
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();