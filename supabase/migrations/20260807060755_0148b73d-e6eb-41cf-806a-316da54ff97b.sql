CREATE TABLE public.coverage_gap_alerts (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  action_type text NOT NULL,
  severity text NOT NULL DEFAULT 'attention',
  cause text NOT NULL DEFAULT '',
  first_seen_at timestamp with time zone NOT NULL DEFAULT now(),
  last_seen_at timestamp with time zone NOT NULL DEFAULT now(),
  observation_count integer NOT NULL DEFAULT 1,
  flagged_at timestamp with time zone,
  status text NOT NULL DEFAULT 'open',
  acknowledged_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  acknowledged_at timestamp with time zone,
  acknowledged_note text,
  resolved_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT coverage_gap_alerts_status_check CHECK (status IN ('open', 'acknowledged', 'resolved'))
);

CREATE UNIQUE INDEX coverage_gap_alerts_open_unique
  ON public.coverage_gap_alerts (user_id, action_type)
  WHERE resolved_at IS NULL;

CREATE INDEX coverage_gap_alerts_flagged_idx
  ON public.coverage_gap_alerts (flagged_at DESC NULLS LAST);

GRANT SELECT, UPDATE ON public.coverage_gap_alerts TO authenticated;
GRANT ALL ON public.coverage_gap_alerts TO service_role;

ALTER TABLE public.coverage_gap_alerts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can view coverage gap alerts"
  ON public.coverage_gap_alerts FOR SELECT TO authenticated
  USING (public.has_role('admin'));

CREATE POLICY "Admins can acknowledge coverage gap alerts"
  ON public.coverage_gap_alerts FOR UPDATE TO authenticated
  USING (public.has_role('admin'))
  WITH CHECK (public.has_role('admin'));

CREATE TRIGGER coverage_gap_alerts_set_updated_at
  BEFORE UPDATE ON public.coverage_gap_alerts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.coverage_gap_scan_runs (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  ran_at timestamp with time zone NOT NULL DEFAULT now(),
  triggered_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  scope text NOT NULL DEFAULT 'scheduled',
  businesses_scanned integer NOT NULL DEFAULT 0,
  gaps_observed integer NOT NULL DEFAULT 0,
  alerts_opened integer NOT NULL DEFAULT 0,
  alerts_flagged integer NOT NULL DEFAULT 0,
  alerts_resolved integer NOT NULL DEFAULT 0,
  duration_ms integer NOT NULL DEFAULT 0,
  detail text,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX coverage_gap_scan_runs_ran_at_idx ON public.coverage_gap_scan_runs (ran_at DESC);

GRANT SELECT ON public.coverage_gap_scan_runs TO authenticated;
GRANT ALL ON public.coverage_gap_scan_runs TO service_role;

ALTER TABLE public.coverage_gap_scan_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can view coverage gap scan runs"
  ON public.coverage_gap_scan_runs FOR SELECT TO authenticated
  USING (public.has_role('admin'));