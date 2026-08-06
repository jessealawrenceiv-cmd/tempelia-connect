CREATE TABLE public.home_quote_dismissals (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  business_owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  quote_id uuid NOT NULL REFERENCES public.quotes(id) ON DELETE CASCADE,
  dismissed_status text NOT NULL,
  dismissed_decline_reason text,
  dismissed_by uuid REFERENCES auth.users(id),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE (quote_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.home_quote_dismissals TO authenticated;
GRANT ALL ON public.home_quote_dismissals TO service_role;

ALTER TABLE public.home_quote_dismissals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Business can view home quote dismissals"
ON public.home_quote_dismissals FOR SELECT TO authenticated
USING (auth.uid() = business_owner_id OR public.is_accepted_team_member(business_owner_id));

CREATE POLICY "Business can create home quote dismissals"
ON public.home_quote_dismissals FOR INSERT TO authenticated
WITH CHECK (auth.uid() = business_owner_id OR public.is_accepted_team_member(business_owner_id));

CREATE POLICY "Business can update home quote dismissals"
ON public.home_quote_dismissals FOR UPDATE TO authenticated
USING (auth.uid() = business_owner_id OR public.is_accepted_team_member(business_owner_id))
WITH CHECK (auth.uid() = business_owner_id OR public.is_accepted_team_member(business_owner_id));

CREATE POLICY "Business can delete home quote dismissals"
ON public.home_quote_dismissals FOR DELETE TO authenticated
USING (auth.uid() = business_owner_id OR public.is_accepted_team_member(business_owner_id));

CREATE INDEX home_quote_dismissals_owner_idx ON public.home_quote_dismissals (business_owner_id);

CREATE TRIGGER home_quote_dismissals_set_updated_at
BEFORE UPDATE ON public.home_quote_dismissals
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();