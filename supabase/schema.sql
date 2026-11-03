-- Run once in the Supabase SQL editor for the Kornu project.
create table if not exists public.kornu_readings (
  user_id uuid not null references auth.users(id) on delete cascade,
  reading_id text not null,
  data jsonb not null check (jsonb_typeof(data) = 'object'),
  updated_at timestamptz not null default now(),
  primary key (user_id, reading_id)
);

alter table public.kornu_readings enable row level security;
revoke all on table public.kornu_readings from anon, authenticated;
grant select, insert, update, delete on table public.kornu_readings to authenticated;

drop policy if exists "Kornu readers select their own readings" on public.kornu_readings;
create policy "Kornu readers select their own readings"
on public.kornu_readings for select to authenticated
using (user_id = (select auth.uid()));

drop policy if exists "Kornu readers insert their own readings" on public.kornu_readings;
create policy "Kornu readers insert their own readings"
on public.kornu_readings for insert to authenticated
with check (user_id = (select auth.uid()));

drop policy if exists "Kornu readers update their own readings" on public.kornu_readings;
create policy "Kornu readers update their own readings"
on public.kornu_readings for update to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

drop policy if exists "Kornu readers delete their own readings" on public.kornu_readings;
create policy "Kornu readers delete their own readings"
on public.kornu_readings for delete to authenticated
using (user_id = (select auth.uid()));

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'kornu-assets', 'kornu-assets', false, 4194304,
  array['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif']
)
on conflict (id) do nothing;

drop policy if exists "Kornu readers see their own images" on storage.objects;
create policy "Kornu readers see their own images"
on storage.objects for select to authenticated
using (bucket_id = 'kornu-assets' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "Kornu readers upload their own images" on storage.objects;
create policy "Kornu readers upload their own images"
on storage.objects for insert to authenticated
with check (bucket_id = 'kornu-assets' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "Kornu readers update their own images" on storage.objects;
create policy "Kornu readers update their own images"
on storage.objects for update to authenticated
using (bucket_id = 'kornu-assets' and (storage.foldername(name))[1] = (select auth.uid())::text)
with check (bucket_id = 'kornu-assets' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "Kornu readers delete their own images" on storage.objects;
create policy "Kornu readers delete their own images"
on storage.objects for delete to authenticated
using (bucket_id = 'kornu-assets' and (storage.foldername(name))[1] = (select auth.uid())::text);
