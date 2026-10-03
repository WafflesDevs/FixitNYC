-- FixItNYC core schema: profiles, reports, vortex, storage, RLS

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to postgres, anon, authenticated, service_role;

create type public.user_role as enum ('client', 'staff');
create type public.city as enum ('Manhattan', 'Brooklyn', 'Queens', 'Bronx', 'Staten Island');
create type public.problem_type as enum ('sanitation', 'infrastructure');
create type public.report_status as enum ('submitted', 'in_review', 'in_progress', 'resolved', 'closed');
create type public.priority_level as enum ('high', 'low');

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text not null default '',
  email text not null,
  role public.user_role not null default 'client',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references public.profiles (id) on delete cascade,
  address_area text not null,
  city public.city not null,
  name text not null,
  problem_type public.problem_type not null,
  image_path text,
  reported_at timestamptz not null default now(),
  additional_info text,
  status public.report_status not null default 'submitted',
  priority public.priority_level not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.vortex_conversations (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.vortex_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.vortex_conversations (id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  created_at timestamptz not null default now()
);

create index reports_reporter_id_idx on public.reports (reporter_id);
create index reports_status_idx on public.reports (status);
create index reports_priority_idx on public.reports (priority);
create index reports_city_idx on public.reports (city);
create index reports_problem_type_idx on public.reports (problem_type);
create index reports_reported_at_idx on public.reports (reported_at desc);
create index vortex_conversations_staff_id_idx on public.vortex_conversations (staff_id);
create index vortex_messages_conversation_id_idx on public.vortex_messages (conversation_id);

create or replace function private.set_updated_at()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function private.set_updated_at();

create trigger reports_set_updated_at
before update on public.reports
for each row execute function private.set_updated_at();

create trigger vortex_conversations_set_updated_at
before update on public.vortex_conversations
for each row execute function private.set_updated_at();

create or replace function private.is_staff()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.role = 'staff'::public.user_role
  );
$$;

revoke all on function private.is_staff() from public;
grant execute on function private.is_staff() to anon, authenticated, service_role;

create or replace function private.enforce_profile_role_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.role is distinct from old.role then
    if auth.role() is distinct from 'service_role' and not private.is_staff() then
      raise exception 'Only staff can change roles';
    end if;
  end if;
  return new;
end;
$$;

create trigger profiles_role_guard
before update on public.profiles
for each row execute function private.enforce_profile_role_guard();

create or replace function private.enforce_report_staff_fields_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status is distinct from old.status
     or new.priority is distinct from old.priority then
    if auth.role() is distinct from 'service_role' and not private.is_staff() then
      raise exception 'Only staff can change status or priority';
    end if;
  end if;
  return new;
end;
$$;

create trigger reports_staff_fields_guard
before update on public.reports
for each row execute function private.enforce_report_staff_fields_guard();

alter table public.profiles enable row level security;
alter table public.reports enable row level security;
alter table public.vortex_conversations enable row level security;
alter table public.vortex_messages enable row level security;

create policy "profiles_select_own_or_staff"
on public.profiles for select to authenticated
using (id = auth.uid() or private.is_staff());

create policy "profiles_insert_own"
on public.profiles for insert to authenticated
with check (id = auth.uid());

create policy "profiles_update_own_or_staff"
on public.profiles for update to authenticated
using (id = auth.uid() or private.is_staff())
with check (id = auth.uid() or private.is_staff());

create policy "reports_select_own_or_staff"
on public.reports for select to authenticated
using (reporter_id = auth.uid() or private.is_staff());

create policy "reports_insert_own"
on public.reports for insert to authenticated
with check (reporter_id = auth.uid());

create policy "reports_update_staff"
on public.reports for update to authenticated
using (private.is_staff())
with check (private.is_staff());

create policy "vortex_conversations_select_own"
on public.vortex_conversations for select to authenticated
using (staff_id = auth.uid() and private.is_staff());

create policy "vortex_conversations_insert_own"
on public.vortex_conversations for insert to authenticated
with check (staff_id = auth.uid() and private.is_staff());

create policy "vortex_conversations_update_own"
on public.vortex_conversations for update to authenticated
using (staff_id = auth.uid() and private.is_staff())
with check (staff_id = auth.uid() and private.is_staff());

create policy "vortex_messages_select_own"
on public.vortex_messages for select to authenticated
using (
  exists (
    select 1
    from public.vortex_conversations c
    where c.id = conversation_id
      and c.staff_id = auth.uid()
      and private.is_staff()
  )
);

create policy "vortex_messages_insert_own"
on public.vortex_messages for insert to authenticated
with check (
  exists (
    select 1
    from public.vortex_conversations c
    where c.id = conversation_id
      and c.staff_id = auth.uid()
      and private.is_staff()
  )
);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'report-images',
  'report-images',
  false,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy "report_images_insert_own"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'report-images'
  and (storage.foldername(name))[1] = auth.uid()::text
);

create policy "report_images_select_own_or_staff"
on storage.objects for select to authenticated
using (
  bucket_id = 'report-images'
  and (
    (storage.foldername(name))[1] = auth.uid()::text
    or private.is_staff()
  )
);
