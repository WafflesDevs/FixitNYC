create or replace function private.enforce_profile_role_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.role is distinct from old.role then
    if auth.role() is distinct from 'service_role'
       and not private.is_staff()
       and not (
         session_user in ('postgres', 'supabase_admin')
         and auth.jwt() is null
       )
    then
      raise exception 'Only staff can change roles';
    end if;
  end if;
  return new;
end;
$$;
