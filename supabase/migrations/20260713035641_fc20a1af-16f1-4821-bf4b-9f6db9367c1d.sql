CREATE POLICY "Business owners upload own intake photos"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'intake-photos' AND (storage.foldername(name))[1] = (auth.uid())::text);

CREATE POLICY "Business owners update own intake photos"
ON storage.objects FOR UPDATE TO authenticated
USING (bucket_id = 'intake-photos' AND (storage.foldername(name))[1] = (auth.uid())::text)
WITH CHECK (bucket_id = 'intake-photos' AND (storage.foldername(name))[1] = (auth.uid())::text);