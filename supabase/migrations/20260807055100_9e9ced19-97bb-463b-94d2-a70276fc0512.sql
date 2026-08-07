CREATE TABLE public.log_write_rejections (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  actor_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  rejected_action_type TEXT,
  rejected_action_types TEXT[] NOT NULL DEFAULT '{}',
  blocked_at TEXT NOT NULL DEFAULT 'server',
  constraint_name TEXT,
  error_code TEXT,
  error_message TEXT,
  attempted_row JSONB NOT NULL DEFAULT '{}'::jsonb,
  request_path TEXT,
  user_agent TEXT,
  correlation_id TEXT,
  occurred_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  CONSTRAINT log_write_rejections_blocked_at_check CHECK (blocked_at IN ('client', 'server', 'database'))
);

GRANT SELECT ON public.log_write_rejections TO authenticated;
GRANT ALL ON public.log_write_rejections TO service_role;

ALTER TABLE public.log_write_rejections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can view log write rejections"
  ON public.log_write_rejections
  FOR SELECT
  TO authenticated
  USING (public.has_role('admin'));

CREATE INDEX log_write_rejections_occurred_at_idx
  ON public.log_write_rejections (occurred_at DESC);
CREATE INDEX log_write_rejections_action_type_idx
  ON public.log_write_rejections (rejected_action_type);

CREATE OR REPLACE FUNCTION public.log_write_rejections_prune()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  DELETE FROM public.log_write_rejections
  WHERE occurred_at < now() - interval '90 days';
$$;