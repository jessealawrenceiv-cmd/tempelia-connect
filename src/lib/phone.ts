/**
 * Client-safe phone normalization to E.164. Shared by the settings UI (inline
 * validation before sending) and the server functions (authoritative check).
 */

export type PhoneParseResult =
  | { ok: true; e164: string; digits: string }
  | { ok: false; error: string };

export function normalizeToE164(input: string | null | undefined): PhoneParseResult {
  const raw = (input ?? "").trim();
  if (!raw) return { ok: false, error: "Enter a phone number." };
  if (raw.length > 24) return { ok: false, error: "That number is too long to be valid." };
  if (/[a-z]/i.test(raw)) return { ok: false, error: "Phone numbers can't contain letters." };

  const hadPlus = raw.startsWith("+");
  const digits = raw.replace(/\D/g, "");
  if (!digits) return { ok: false, error: "Enter a phone number with digits." };

  // Bare US 10-digit, or 11-digit starting with the US country code.
  let normalized: string;
  if (!hadPlus && digits.length === 10) {
    normalized = `1${digits}`;
  } else if (digits.length === 11 && digits.startsWith("1")) {
    normalized = digits;
  } else if (hadPlus && digits.length >= 8 && digits.length <= 15) {
    normalized = digits;
  } else if (!hadPlus && digits.length >= 11 && digits.length <= 15) {
    // International without the leading "+" — accept, but only unambiguously.
    normalized = digits;
  } else if (digits.length < 10) {
    return { ok: false, error: `Too short — got ${digits.length} digits, need a full 10-digit US number.` };
  } else {
    return { ok: false, error: "Not a valid number. Use a 10-digit US number or full E.164 (+15015550123)." };
  }

  // US-specific sanity: area code and exchange can't start with 0 or 1.
  if (normalized.startsWith("1") && normalized.length === 11) {
    const area = normalized.slice(1, 4);
    const exchange = normalized.slice(4, 7);
    if (/^[01]/.test(area)) return { ok: false, error: `Invalid US area code "${area}".` };
    if (/^[01]/.test(exchange)) return { ok: false, error: `Invalid US exchange "${exchange}".` };
  }

  return { ok: true, e164: `+${normalized}`, digits: normalized };
}

/** Digits-only comparison key (used for exclusion-list matching). */
export function phoneDigits(p: string | null | undefined): string {
  return (p ?? "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
}

/** Pretty US display, falling back to the E.164 form. */
export function formatPhoneDisplay(p: string | null | undefined): string {
  const parsed = normalizeToE164(p);
  if (!parsed.ok) return (p ?? "").trim();
  const d = parsed.digits;
  if (d.length === 11 && d.startsWith("1")) {
    return `+1 (${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
  }
  return parsed.e164;
}
