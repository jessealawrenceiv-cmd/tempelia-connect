CREATE TABLE public.intake_submissions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  customer_first_name TEXT NOT NULL,
  customer_last_name TEXT NOT NULL,
  customer_business_name TEXT,
  customer_phone TEXT NOT NULL,
  customer_email TEXT,
  responses JSONB NOT NULL DEFAULT '{}'::jsonb,
  photo_urls TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  source TEXT NOT NULL DEFAULT 'web',
  status TEXT NOT NULL DEFAULT 'new',
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.intake_submissions TO authenticated;
GRANT ALL ON public.intake_submissions TO service_role;

ALTER TABLE public.intake_submissions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owners manage own intake submissions"
ON public.intake_submissions
FOR ALL
TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

CREATE INDEX idx_intake_submissions_user_id ON public.intake_submissions(user_id);
CREATE INDEX idx_intake_submissions_submitted_at ON public.intake_submissions(submitted_at DESC);

CREATE TRIGGER intake_submissions_set_updated_at
BEFORE UPDATE ON public.intake_submissions
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();