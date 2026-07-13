ALTER PUBLICATION supabase_realtime ADD TABLE public.intake_submissions;
ALTER PUBLICATION supabase_realtime ADD TABLE public.customers;
ALTER TABLE public.intake_submissions REPLICA IDENTITY FULL;
ALTER TABLE public.customers REPLICA IDENTITY FULL;