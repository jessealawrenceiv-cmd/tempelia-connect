revoke execute on function public.has_active_subscription(uuid, text) from anon;
revoke execute on function public.has_active_subscription(uuid, text) from authenticated;
revoke execute on function public.has_active_subscription(uuid, text) from public;
grant execute on function public.has_active_subscription(uuid, text) to service_role;
