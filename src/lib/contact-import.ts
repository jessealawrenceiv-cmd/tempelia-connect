/**
 * CSV bulk-import logic for Contacts — pure, client-safe, unit-tested.
 *
 * HARD RULE: consent is never derived from the CSV. Imported contacts are
 * always created with opt_in_consent = false and consent_form_signed = false.
 * There is deliberately no option, mapping target, or flag that can change
 * this. Being a customer in someone's old software is not consent to receive
 * automated texts through Temaro.
 */

import { normalizeToE164 } from "./phone";

export const IMPORT_ATTESTATION_TEXT =
  "I confirm these contacts have previously interacted with my business and I have a legitimate basis to add them to Temaro.";

/** Fields a CSV column may be mapped onto. Consent is NOT mappable, by design. */
export const IMPORT_FIELDS = [
  "first_name",
  "last_name",
  "business_name",
  "phone",
  "email",
  "notes",
] as const;

export type ImportField = (typeof IMPORT_FIELDS)[number];

export const IMPORT_FIELD_LABELS: Record<ImportField, string> = {
  first_name: "First name",
  last_name: "Last name",
  business_name: "Business name",
  phone: "Phone number (required)",
  email: "Email",
  notes: "Notes",
};

/** header index -> field ("" / undefined means "ignore this column") */
export type ColumnMapping = Record<number, ImportField | "">;

export type ParsedCsv = { headers: string[]; rows: string[][] };

/* ------------------------------------------------------------------ parsing */

/** RFC4180-ish CSV parser: quoted fields, escaped quotes, CRLF, trailing newline. */
export function parseCsv(text: string): ParsedCsv {
  const src = text.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let touched = false;

  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    // Drop rows that are entirely empty (e.g. trailing newline).
    if (row.some((c) => c.trim() !== "")) rows.push(row);
    row = [];
    touched = false;
  };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
      touched = true;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      touched = true;
      continue;
    }
    if (ch === ",") {
      endField();
      touched = true;
      continue;
    }
    if (ch === "\r") continue;
    if (ch === "\n") {
      endRow();
      continue;
    }
    field += ch;
    touched = true;
  }
  if (touched || field !== "" || row.length) endRow();

  const headerRow = rows.shift() ?? [];
  const headers = headerRow.map((h, i) => h.trim() || `Column ${i + 1}`);
  return { headers, rows };
}

/* ------------------------------------------------------------------ mapping */

const AUTO_MATCH: Array<[ImportField, RegExp]> = [
  ["phone", /^(phone|phone[\s_-]?number|mobile|cell|telephone|tel|primary\s*phone)$/i],
  ["first_name", /^(first[\s_-]?name|firstname|given[\s_-]?name|fname)$/i],
  ["last_name", /^(last[\s_-]?name|lastname|surname|family[\s_-]?name|lname)$/i],
  ["business_name", /^(business|business[\s_-]?name|company|company[\s_-]?name|organization|org)$/i],
  ["email", /^(email|e-?mail|email[\s_-]?address)$/i],
  ["notes", /^(notes?|comment|comments|description|remarks)$/i],
];

/** Best-effort initial mapping. Never guesses consent columns. */
export function autoDetectMapping(headers: string[]): ColumnMapping {
  const mapping: ColumnMapping = {};
  const used = new Set<ImportField>();
  headers.forEach((h, i) => {
    const clean = h.trim();
    const hit = AUTO_MATCH.find(([field, re]) => !used.has(field) && re.test(clean));
    if (hit) {
      mapping[i] = hit[0];
      used.add(hit[0]);
    } else mapping[i] = "";
  });
  return mapping;
}

/** Reject a mapping that assigns the same field twice, or omits phone. */
export function validateMapping(mapping: ColumnMapping): { ok: true } | { ok: false; error: string } {
  const seen = new Map<ImportField, number>();
  for (const [idx, field] of Object.entries(mapping)) {
    if (!field) continue;
    if (seen.has(field)) {
      return { ok: false, error: `"${IMPORT_FIELD_LABELS[field]}" is mapped to more than one column.` };
    }
    seen.set(field, Number(idx));
  }
  if (!seen.has("phone")) {
    return { ok: false, error: "Map one column to the phone number — it's required for every contact." };
  }
  return { ok: true };
}

/* ---------------------------------------------------------------- row shape */

export type MappedRow = {
  rowNumber: number; // 1-based data row (excludes the header line)
  first_name: string | null;
  last_name: string | null;
  business_name: string | null;
  phone: string | null; // normalized E.164 when valid
  email: string | null;
  notes: string | null;
  error: string | null; // set => row is skipped
};

function clean(v: string | undefined, max = 500): string | null {
  const t = (v ?? "").trim();
  if (!t) return null;
  return t.slice(0, max);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Apply the mapping to raw rows, normalizing values and flagging skips. */
export function mapRows(parsed: ParsedCsv, mapping: ColumnMapping): MappedRow[] {
  const byField = new Map<ImportField, number>();
  Object.entries(mapping).forEach(([idx, field]) => {
    if (field) byField.set(field, Number(idx));
  });
  const get = (row: string[], field: ImportField) => {
    const i = byField.get(field);
    return i === undefined ? undefined : row[i];
  };

  return parsed.rows.map((row, i) => {
    const rawPhone = clean(get(row, "phone"), 40);
    const parsedPhone = rawPhone ? normalizeToE164(rawPhone) : null;
    const emailRaw = clean(get(row, "email"), 255);
    const email = emailRaw && EMAIL_RE.test(emailRaw) ? emailRaw.toLowerCase() : null;

    let error: string | null = null;
    if (!rawPhone) error = "Missing phone number";
    else if (!parsedPhone?.ok) error = `Invalid phone number "${rawPhone}"`;

    return {
      rowNumber: i + 1,
      first_name: clean(get(row, "first_name"), 120),
      last_name: clean(get(row, "last_name"), 120),
      business_name: clean(get(row, "business_name"), 200),
      phone: parsedPhone?.ok ? parsedPhone.e164 : null,
      email,
      notes: clean(get(row, "notes"), 2000),
      error,
    };
  });
}

/** Collapse duplicate phones inside one file: first row wins, later rows merge blanks. */
export function dedupeWithinFile(rows: MappedRow[]): { rows: MappedRow[]; collapsed: number } {
  const byPhone = new Map<string, MappedRow>();
  const out: MappedRow[] = [];
  let collapsed = 0;
  for (const r of rows) {
    if (r.error || !r.phone) {
      out.push(r);
      continue;
    }
    const existing = byPhone.get(r.phone);
    if (!existing) {
      byPhone.set(r.phone, r);
      out.push(r);
      continue;
    }
    collapsed++;
    for (const f of ["first_name", "last_name", "business_name", "email", "notes"] as const) {
      if (!existing[f] && r[f]) existing[f] = r[f];
    }
  }
  return { rows: out, collapsed };
}

/* --------------------------------------------------------- non-destructive merge */

export type ExistingContact = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  notes: string | null;
};

/**
 * Fill only blank/missing fields on an existing contact. Real data on file is
 * never overwritten by imported values. Consent columns are never touched.
 */
export function buildMergePatch(
  existing: ExistingContact,
  row: MappedRow,
): Record<string, string> {
  const patch: Record<string, string> = {};
  const isBlank = (v: string | null) => !v || !v.trim();
  if (isBlank(existing.first_name) && row.first_name) patch["first_name"] = row.first_name;
  if (isBlank(existing.last_name) && row.last_name) patch["last_name"] = row.last_name;
  if (isBlank(existing.email) && row.email) patch["email"] = row.email;

  const importedNotes = [row.business_name ? `Business: ${row.business_name}` : null, row.notes]
    .filter(Boolean)
    .join(" — ");
  if (isBlank(existing.notes) && importedNotes) patch["notes"] = importedNotes;
  return patch;
}

/** Notes value for a brand-new contact (business name folded in, no dedicated column). */
export function buildInsertNotes(row: MappedRow): string | null {
  const parts = [row.business_name ? `Business: ${row.business_name}` : null, row.notes].filter(Boolean);
  return parts.length ? parts.join(" — ") : null;
}

/* -------------------------------------------------------------------- summary */

export type SkipReason = { rowNumber: number; reason: string };

export type ImportSummary = {
  totalRows: number;
  imported: number;
  updated: number;
  matchedExisting: number;
  skipped: number;
  collapsedDuplicates: number;
  skippedReasons: SkipReason[];
};

/** "142 imported, 8 skipped — missing phone number" */
export function summaryHeadline(s: ImportSummary): string {
  const bits = [`${s.imported} imported`];
  if (s.updated) bits.push(`${s.updated} merged into existing contacts`);
  if (s.matchedExisting - s.updated > 0) {
    bits.push(`${s.matchedExisting - s.updated} already on file, left unchanged`);
  }
  bits.push(`${s.skipped} skipped`);
  let line = bits.join(", ");
  if (s.skipped) {
    const counts = new Map<string, number>();
    s.skippedReasons.forEach((r) => {
      const key = r.reason.replace(/"[^"]*"/, "").trim().toLowerCase();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    });
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
    line += ` — ${top.join("; ")}`;
  }
  return line;
}
