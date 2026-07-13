ALTER TABLE public.quotes DROP CONSTRAINT quotes_status_check;
ALTER TABLE public.quotes ADD CONSTRAINT quotes_status_check CHECK (status = ANY (ARRAY['draft'::text, 'sent'::text, 'accepted'::text, 'declined'::text, 'expired'::text, 'archived'::text]));
ALTER TABLE public.quotes ADD COLUMN IF NOT EXISTS superseded_by_id uuid REFERENCES public.quotes(id) ON DELETE SET NULL;
ALTER TABLE public.quotes ADD COLUMN IF NOT EXISTS archived_at timestamptz;
CREATE INDEX IF NOT EXISTS quotes_superseded_by_id_idx ON public.quotes(superseded_by_id);