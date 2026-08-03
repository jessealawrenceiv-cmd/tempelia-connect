UPDATE public.profiles
SET twilio_phone_number = '+15017256527',
    twilio_provisioned_at = COALESCE(twilio_provisioned_at, now())
WHERE id = '7d429771-e89a-4587-95a4-f7cf9d1e7cb5';

UPDATE public.profiles
SET owner_phone = '+17372583742'
WHERE id = '7d429771-e89a-4587-95a4-f7cf9d1e7cb5' AND owner_phone = '17372583742';