REVOKE ALL ON FUNCTION public.webhook_events_prune() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.webhook_events_prune() TO service_role;