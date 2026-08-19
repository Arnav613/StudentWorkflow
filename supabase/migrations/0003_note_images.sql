-- 0003_note_images.sql — Phase 05. Storage for images pasted into notes.
--
-- The `notes` table itself has existed since migration one, so nothing here
-- touches it. What phase 05 actually needs from the database is a place to put
-- images, guarded the same way every other row is: owner-only, enforced by the
-- database rather than by the code that happens to be calling it.
--
-- The bucket is PRIVATE. A public bucket would be simpler — a permanent URL
-- straight into the block tree — but it would also mean every image in every
-- note is readable by anyone who has, guesses, or is forwarded the URL, with
-- no login involved. Notes are the most personal thing this app stores, and
-- "nobody will guess a uuid" is not a permission model.
--
-- The consequence is that a note stores an object *path*, never a URL: the
-- browser signs a short-lived URL when it renders the image. An expiring URL
-- written into the document would rot in place, and the rot would show up
-- weeks later as a note full of broken images.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'note-images',
  'note-images',
  false,
  -- 10 MB. A phone photo of a whiteboard is 3-5 MB; anything past this is a
  -- mistake, and the free tier is 1 GB in total.
  10485760,
  array['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml']
)
on conflict (id) do nothing;

-- Objects are keyed `<user_id>/<note_id>/<random>.<ext>`. The first path
-- segment is the whole access rule: you may touch an object only inside the
-- folder named after your own uid. The note id in the second segment is not a
-- permission — it is what makes deleting a note able to take its images with
-- it, rather than leaving them to accumulate forever.
create policy note_images_select_own on storage.objects
  for select to authenticated
  using (
    bucket_id = 'note-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy note_images_insert_own on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'note-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy note_images_update_own on storage.objects
  for update to authenticated
  using (
    bucket_id = 'note-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy note_images_delete_own on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'note-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
