CREATE TABLE public.team_invite_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  team_member_id uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  actor_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  invited_email text NOT NULL,
  event_type text NOT NULL,
  detail text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT ON public.team_invite_events TO authenticated;
GRANT ALL ON public.team_invite_events TO service_role;

ALTER TABLE public.team_invite_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owners read own invite events"
  ON public.team_invite_events FOR SELECT TO authenticated
  USING (business_owner_id = auth.uid());

CREATE POLICY "Staff read business invite events"
  ON public.team_invite_events FOR SELECT TO authenticated
  USING (public.is_accepted_team_member(business_owner_id));

CREATE POLICY "Owners insert own invite events"
  ON public.team_invite_events FOR INSERT TO authenticated
  WITH CHECK (business_owner_id = auth.uid() AND actor_user_id = auth.uid());

CREATE POLICY "Staff insert own acceptance events"
  ON public.team_invite_events FOR INSERT TO authenticated
  WITH CHECK (actor_user_id = auth.uid() AND event_type = 'accepted');

CREATE INDEX team_invite_events_owner_idx
  ON public.team_invite_events (business_owner_id, occurred_at DESC);

CREATE INDEX team_invite_events_email_idx
  ON public.team_invite_events (business_owner_id, lower(invited_email));