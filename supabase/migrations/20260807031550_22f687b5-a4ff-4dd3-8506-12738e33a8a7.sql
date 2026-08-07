CREATE TABLE public.activity_log_filter_rejections (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID,
  source TEXT NOT NULL,
  blocked BOOLEAN NOT NULL DEFAULT false,
  issue_fields TEXT[] NOT NULL DEFAULT '{}',
  issues JSONB NOT NULL DEFAULT '[]'::jsonb,
  raw_filters JSONB NOT NULL DEFAULT '{}'::jsonb,
  user_agent TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE INDEX activity_log_filter_rejections_created_at_idx
  ON public.activity_log_filter_rejections (created_at DESC);
CREATE INDEX activity_log_filter_rejections_user_idx
  ON public.activity_log_filter_rejections (user_id, created_at DESC);

GRANT SELECT ON public.activity_log_filter_rejections TO authenticated;
GRANT ALL ON public.activity_log_filter_rejections TO service_role;

ALTER TABLE public.activity_log_filter_rejections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own filter rejections"
  ON public.activity_log_filter_rejections
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "Admins can view all filter rejections"
  ON public.activity_log_filter_rejections
  FOR SELECT TO authenticated
  USING (public.has_role('admin'::app_role));

SELECT cron.schedule(
  'activity-log-filter-rejections-cleanup',
  '25 4 * * *',
  $$DELETE FROM public.activity_log_filter_rejections WHERE created_at < now() - interval '30 days'$$
);