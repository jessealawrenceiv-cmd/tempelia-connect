
-- Allow anonymous public intake photo uploads, restrict reads to the owning business
CREATE POLICY "Anyone can upload intake photos"
ON storage.objects FOR INSERT
TO anon, authenticated
WITH CHECK (bucket_id = 'intake-photos');

CREATE POLICY "Business owners read own intake photos"
ON storage.objects FOR SELECT
TO authenticated
USING (
  bucket_id = 'intake-photos'
  AND (storage.foldername(name))[1] = auth.uid()::text
);

CREATE POLICY "Business owners delete own intake photos"
ON storage.objects FOR DELETE
TO authenticated
USING (
  bucket_id = 'intake-photos'
  AND (storage.foldername(name))[1] = auth.uid()::text
);
