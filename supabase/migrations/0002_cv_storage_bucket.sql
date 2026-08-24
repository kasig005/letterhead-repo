insert into storage.buckets (id, name, public)
values ('cv-files', 'cv-files', false)
on conflict (id) do nothing;

create policy "cv_files_select_own" on storage.objects
  for select using (bucket_id = 'cv-files' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "cv_files_insert_own" on storage.objects
  for insert with check (bucket_id = 'cv-files' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "cv_files_update_own" on storage.objects
  for update using (bucket_id = 'cv-files' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'cv-files' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "cv_files_delete_own" on storage.objects
  for delete using (bucket_id = 'cv-files' and (storage.foldername(name))[1] = auth.uid()::text);
