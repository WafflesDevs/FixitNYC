-- Wrap auth helpers in (select ...) for RLS initplan performance.

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
    where p.id = (select auth.uid())
      and p.role = 'staff'::public.user_role
  );
$$;

drop policy if exists "profiles_select_own_or_staff" on public.profiles;
create policy "profiles_select_own_or_staff"
on public.profiles for select to authenticated
using (id = (select auth.uid()) or (select private.is_staff()));

drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own"
on public.profiles for insert to authenticated
with check (id = (select auth.uid()));

drop policy if exists "profiles_update_own_or_staff" on public.profiles;
create policy "profiles_update_own_or_staff"
on public.profiles for update to authenticated
using (id = (select auth.uid()) or (select private.is_staff()))
with check (id = (select auth.uid()) or (select private.is_staff()));

drop policy if exists "reports_select_own_or_staff" on public.reports;
create policy "reports_select_own_or_staff"
on public.reports for select to authenticated
using (reporter_id = (select auth.uid()) or (select private.is_staff()));

drop policy if exists "reports_insert_own" on public.reports;
create policy "reports_insert_own"
on public.reports for insert to authenticated
with check (reporter_id = (select auth.uid()));

drop policy if exists "reports_update_staff" on public.reports;
create policy "reports_update_staff"
on public.reports for update to authenticated
using ((select private.is_staff()))
with check ((select private.is_staff()));

drop policy if exists "vortex_conversations_select_own" on public.vortex_conversations;
create policy "vortex_conversations_select_own"
on public.vortex_conversations for select to authenticated
using (staff_id = (select auth.uid()) and (select private.is_staff()));

drop policy if exists "vortex_conversations_insert_own" on public.vortex_conversations;
create policy "vortex_conversations_insert_own"
on public.vortex_conversations for insert to authenticated
with check (staff_id = (select auth.uid()) and (select private.is_staff()));

drop policy if exists "vortex_conversations_update_own" on public.vortex_conversations;
create policy "vortex_conversations_update_own"
on public.vortex_conversations for update to authenticated
using (staff_id = (select auth.uid()) and (select private.is_staff()))
with check (staff_id = (select auth.uid()) and (select private.is_staff()));

drop policy if exists "vortex_messages_select_own" on public.vortex_messages;
create policy "vortex_messages_select_own"
on public.vortex_messages for select to authenticated
using (
  exists (
    select 1
    from public.vortex_conversations c
    where c.id = conversation_id
      and c.staff_id = (select auth.uid())
      and (select private.is_staff())
  )
);

drop policy if exists "vortex_messages_insert_own" on public.vortex_messages;
create policy "vortex_messages_insert_own"
on public.vortex_messages for insert to authenticated
with check (
  exists (
    select 1
    from public.vortex_conversations c
    where c.id = conversation_id
      and c.staff_id = (select auth.uid())
      and (select private.is_staff())
  )
);

drop policy if exists "report_images_insert_own" on storage.objects;
create policy "report_images_insert_own"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'report-images'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);

drop policy if exists "report_images_select_own_or_staff" on storage.objects;
create policy "report_images_select_own_or_staff"
on storage.objects for select to authenticated
using (
  bucket_id = 'report-images'
  and (
    (storage.foldername(name))[1] = (select auth.uid())::text
    or (select private.is_staff())
  )
);
