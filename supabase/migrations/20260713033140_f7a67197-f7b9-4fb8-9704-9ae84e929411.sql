ALTER TABLE public.quotes
  ADD COLUMN customer_id uuid NULL REFERENCES public.customers(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS quotes_customer_id_idx ON public.quotes(customer_id);