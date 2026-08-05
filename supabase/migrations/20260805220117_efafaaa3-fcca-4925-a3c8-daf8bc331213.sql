CREATE TABLE public.contact_import_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  actor_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  file_name text,
  column_mapping jsonb NOT NULL DEFAULT '{}'::jsonb,
  attestation_text text NOT NULL,
  attestation_accepted_at timestamptz NOT NULL DEFAULT now(),
  total_rows integer NOT NULL DEFAULT 0,
  imported_count integer NOT NULL DEFAULT 0,
  updated_count integer NOT NULL DEFAULT 0,
  skipped_count integer NOT NULL DEFAULT 0,
  skipped_reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT ON public.contact_import_events TO authenticated;
GRANT ALL ON public.contact_import_events TO service_role;

ALTER TABLE public.contact_import_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owners and team can view import events"
  ON public.contact_import_events FOR SELECT TO authenticated
  USING (auth.uid() = user_id OR public.is_accepted_team_member(user_id));

CREATE POLICY "Owners and team can insert import events"
  ON public.contact_import_events FOR INSERT TO authenticated
  WITH CHECK (
    (auth.uid() = user_id OR public.is_accepted_team_member(user_id))
    AND actor_user_id = auth.uid()
  );

CREATE INDEX contact_import_events_user_occurred_idx
  ON public.contact_import_events (user_id, occurred_at DESC);