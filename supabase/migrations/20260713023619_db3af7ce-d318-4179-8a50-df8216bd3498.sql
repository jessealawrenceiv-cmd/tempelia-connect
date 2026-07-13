-- Real DB-level guards for quotes (no subqueries; JSONPath for array element rules).

ALTER TABLE public.quotes
  ADD CONSTRAINT quotes_subtotal_nonneg     CHECK (subtotal     >= 0),
  ADD CONSTRAINT quotes_tax_amount_nonneg   CHECK (tax_amount   >= 0),
  ADD CONSTRAINT quotes_total_amount_nonneg CHECK (total_amount >= 0),
  ADD CONSTRAINT quotes_tax_rate_nonneg     CHECK (tax_rate     >= 0);

ALTER TABLE public.quotes
  ADD CONSTRAINT quotes_line_items_is_array
  CHECK (jsonb_typeof(line_items) = 'array');

-- Reject any line item whose "amount" is missing, non-numeric, or negative.
-- @? returns true if the JSONPath matches any element; we require NO match.
ALTER TABLE public.quotes
  ADD CONSTRAINT quotes_line_items_amounts_valid
  CHECK (
    NOT (line_items @? '$[*] ? (!(@.amount.type() == "number") || @.amount < 0)')
  );

-- "sent" must be a real quote: at least one line item and a positive total.
-- Drafts stay exempt.
ALTER TABLE public.quotes
  ADD CONSTRAINT quotes_sent_requires_line_items
  CHECK (
    status <> 'sent'
    OR (jsonb_array_length(line_items) > 0 AND total_amount > 0)
  );
