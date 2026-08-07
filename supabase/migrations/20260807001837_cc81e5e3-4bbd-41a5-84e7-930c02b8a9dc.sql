CREATE TABLE public.webhook_deliveries (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  source text NOT NULL,
  event_kind text NOT NULL,
  delivery_key text NOT NULL,
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'processing' CHECK (state IN ('processing','done','failed')),
  response_body text,
  response_content_type text,
  response_status integer,
  attempt_count integer NOT NULL DEFAULT 1,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT webhook_deliveries_key_unique UNIQUE (source, delivery_key)
);

GRANT ALL ON public.webhook_deliveries TO service_role;
ALTER TABLE public.webhook_deliveries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owners can view their webhook deliveries"
ON public.webhook_deliveries FOR SELECT TO authenticated
USING (user_id = auth.uid());
GRANT SELECT ON public.webhook_deliveries TO authenticated;

CREATE INDEX idx_webhook_deliveries_seen ON public.webhook_deliveries (last_seen_at DESC);

-- Atomic claim: first delivery of a key inserts and claims; retries bump the
-- attempt counter and return the stored response instead of re-processing.
CREATE OR REPLACE FUNCTION public.webhook_delivery_claim(
  _source text,
  _event_kind text,
  _delivery_key text
)
RETURNS TABLE (
  delivery_id uuid,
  is_duplicate boolean,
  state text,
  response_body text,
  response_content_type text,
  response_status integer,
  attempt_count integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _row public.webhook_deliveries;
BEGIN
  INSERT INTO public.webhook_deliveries (source, event_kind, delivery_key)
  VALUES (_source, _event_kind, _delivery_key)
  ON CONFLICT (source, delivery_key) DO NOTHING
  RETURNING * INTO _row;

  IF _row.id IS NOT NULL THEN
    RETURN QUERY SELECT _row.id, false, _row.state, _row.response_body,
      _row.response_content_type, _row.response_status, _row.attempt_count;
    RETURN;
  END IF;

  UPDATE public.webhook_deliveries d
  SET attempt_count = d.attempt_count + 1,
      last_seen_at = now()
  WHERE d.source = _source AND d.delivery_key = _delivery_key
  RETURNING * INTO _row;

  RETURN QUERY SELECT _row.id, true, _row.state, _row.response_body,
    _row.response_content_type, _row.response_status, _row.attempt_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.webhook_delivery_complete(
  _delivery_id uuid,
  _user_id uuid,
  _state text,
  _response_body text,
  _response_content_type text,
  _response_status integer
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.webhook_deliveries
  SET state = _state,
      user_id = COALESCE(_user_id, user_id),
      response_body = _response_body,
      response_content_type = _response_content_type,
      response_status = _response_status,
      completed_at = now()
  WHERE id = _delivery_id;
$$;

-- Retention: keep 30 days of delivery keys (well beyond Twilio's retry window).
CREATE OR REPLACE FUNCTION public.webhook_deliveries_prune()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  DELETE FROM public.webhook_deliveries WHERE last_seen_at < now() - interval '30 days';
$$;