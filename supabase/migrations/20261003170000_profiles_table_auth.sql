-- Detach profiles from Supabase Auth; store credentials on the table.
alter table public.profiles drop constraint if exists profiles_id_fkey;

alter table public.profiles
  alter column id set default gen_random_uuid();

alter table public.profiles
  add column if not exists password_hash text;

update public.profiles
set password_hash = coalesce(nullif(password_hash, ''), '!')
where password_hash is null or password_hash = '';

alter table public.profiles
  alter column password_hash set not null;

create unique index if not exists profiles_email_lower_uidx
  on public.profiles (lower(email));
