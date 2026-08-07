REVOKE ALL ON FUNCTION public.webhook_delivery_claim(text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.webhook_delivery_complete(uuid, uuid, text, text, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.webhook_deliveries_prune() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.webhook_delivery_claim(text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.webhook_delivery_complete(uuid, uuid, text, text, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.webhook_deliveries_prune() TO service_role;