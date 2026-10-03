-- Align report statuses with staff workflow:
-- submitted, reviewed, in_progress, canceled, done
create type public.report_status_new as enum (
  'submitted',
  'reviewed',
  'in_progress',
  'canceled',
  'done'
);

alter table public.reports
  alter column status drop default;

alter table public.reports
  alter column status type public.report_status_new
  using (
    case status::text
      when 'submitted' then 'submitted'
      when 'in_review' then 'reviewed'
      when 'in_progress' then 'in_progress'
      when 'resolved' then 'done'
      when 'closed' then 'canceled'
      when 'reviewed' then 'reviewed'
      when 'canceled' then 'canceled'
      when 'done' then 'done'
      else 'submitted'
    end
  )::public.report_status_new;

alter table public.reports
  alter column status set default 'submitted'::public.report_status_new;

drop type public.report_status;
alter type public.report_status_new rename to report_status;
