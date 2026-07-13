ALTER TABLE public.intake_submissions
  ADD COLUMN customer_id uuid NULL REFERENCES public.customers(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS intake_submissions_customer_id_idx
  ON public.intake_submissions(customer_id);

UPDATE public.intake_submissions s
SET customer_id = c.id
FROM public.customers c
WHERE s.customer_id IS NULL
  AND c.user_id = s.user_id
  AND c.phone_number = s.customer_phone;