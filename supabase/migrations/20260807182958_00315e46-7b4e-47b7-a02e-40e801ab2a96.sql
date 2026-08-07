create or replace function public.logs_action_type_whitelist_ci()
returns table (constraint_name text, constraint_def text, allowed_values text[])
language plpgsql
stable
security definer
set search_path = public, pg_catalog
as $$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def
  FROM pg_constraint
  WHERE conname = 'logs_action_type_check';

  RETURN QUERY
  SELECT
    'logs_action_type_check'::text,
    v_def,
    COALESCE(
      (SELECT array_agg(m[1] ORDER BY ord)
       FROM regexp_matches(COALESCE(v_def, ''), '''((?:[^'']|'''')*)''::text', 'g')
         WITH ORDINALITY AS t(m, ord)),
      ARRAY[]::text[]
    );
END;
$$;

revoke all on function public.logs_action_type_whitelist_ci() from public;
revoke all on function public.logs_action_type_whitelist_ci() from anon;
revoke all on function public.logs_action_type_whitelist_ci() from authenticated;
grant execute on function public.logs_action_type_whitelist_ci() to service_role;