-- Allow anonymous reports: nullable reporter/location, optional contact email

alter table public.reports
  alter column reporter_id drop not null,
  alter column address_area drop not null,
  alter column city drop not null;

alter table public.reports
  add column if not exists contact_email text;
