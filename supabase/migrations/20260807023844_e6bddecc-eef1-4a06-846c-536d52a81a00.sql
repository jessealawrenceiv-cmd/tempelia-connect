REVOKE ALL ON FUNCTION public.reconcile_activity_logs() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.log_reconciliation_runs_prune() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_activity_logs() TO service_role;
GRANT EXECUTE ON FUNCTION public.log_reconciliation_runs_prune() TO service_role;