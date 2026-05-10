-- Migration: 021_avatars_storage_rls
-- Creates the 'avatars' Storage bucket and RLS policy for public read access.
-- Uploads must go through a dedicated Edge Function (uses service_role key)
-- because Fcom uses custom JWT instead of Supabase Auth.

-- Bucket (idempotent)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('avatars', 'avatars', true, 2097152, ARRAY['image/jpeg','image/png','image/webp','image/gif'])
ON CONFLICT (id) DO NOTHING;

-- Public read policy
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'avatars_public_read'
  ) THEN
    CREATE POLICY "avatars_public_read"
      ON storage.objects FOR SELECT
      USING (bucket_id = 'avatars');
  END IF;
END;
$$;
