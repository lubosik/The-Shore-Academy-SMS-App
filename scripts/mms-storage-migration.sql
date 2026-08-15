-- Shore Academy Inbox — durable MMS bucket provisioning.
-- Safe to re-run in the Supabase SQL editor. No objects are deleted.
--
-- The backend uses the service-role key for uploads and returns public URLs to
-- Telnyx/GHL, so the bucket itself must be public. Application routes still
-- enforce the 5 MB/image-only contract before upload.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'mms-media',
  'mms-media',
  true,
  5242880,
  ARRAY['image/jpeg', 'image/png', 'image/gif', 'image/webp']
)
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;
