REVOKE ALL ON FUNCTION public.archive_old_logs(interval, integer, interval) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.archive_old_logs(interval, integer, interval) FROM anon;
REVOKE ALL ON FUNCTION public.archive_old_logs(interval, integer, interval) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.archive_old_logs(interval, integer, interval) TO postgres;
