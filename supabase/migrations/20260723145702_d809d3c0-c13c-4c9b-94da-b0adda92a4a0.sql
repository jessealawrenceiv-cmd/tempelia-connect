CREATE TABLE public.mcp_rate_limits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  tool_name text NOT NULL,
  called_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mcp_rate_limits_user_tool_time_idx ON public.mcp_rate_limits (user_id, tool_name, called_at DESC);
GRANT ALL ON public.mcp_rate_limits TO service_role;
ALTER TABLE public.mcp_rate_limits ENABLE ROW LEVEL SECURITY;
-- No policies: only the service role (used by MCP tool handlers) touches this table.

-- Retention: drop rows older than 1 day so the table stays tiny.
CREATE OR REPLACE FUNCTION public.mcp_rate_limits_prune()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  DELETE FROM public.mcp_rate_limits WHERE called_at < now() - interval '1 day';
$$;