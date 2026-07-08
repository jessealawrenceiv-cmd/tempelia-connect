create or replace function public.has_active_subscription(
  user_uuid uuid,
  check_env text default 'live'
)
returns boolean
language sql
stable
security invoker
set search_path = public
as $$
  select exists (
    select 1 from public.subscriptions
    where user_id = user_uuid
    and environment = check_env
    and (
      (status in ('active', 'trialing') and (current_period_end is null or current_period_end > now()))
      or (status = 'canceled' and current_period_end > now())
    )
  );
$$;

revoke execute on function public.has_active_subscription(uuid, text) from anon;
revoke execute on function public.has_active_subscription(uuid, text) from authenticated;
revoke execute on function public.has_active_subscription(uuid, text) from public;
grant execute on function public.has_active_subscription(uuid, text) to service_role;
