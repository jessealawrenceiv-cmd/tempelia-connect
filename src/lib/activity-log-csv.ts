import { logActionLabel } from "@/lib/log-action-presentation";
import type { LogActionType } from "@/lib/log-action-types";

export const EXPORT_ROW_CAP = 5000;

/** Minimal structural type of the supabase query builder methods used by log filters. */
export type FilterableQuery = {
  gte(column: string, value: string): FilterableQuery;
  lte(column: string, value: string): FilterableQuery;
  lt(column: string, value: string): FilterableQuery;
  gt(column: string, value: string): FilterableQuery;
  eq(column: string, value: string): FilterableQuery;
  in(column: string, values: readonly string[]): FilterableQuery;
  or(filters: string): FilterableQuery;
};

export type ExportableLogRow = {
  id: string;
  action_type: LogActionType;
  message_sent: string | null;
  created_at: string;
  status: string | null;
  customer_id: string | null;
  /** Number the message actually went to, when the record carries one. */
  recipient_phone?: string | null;
};

/**
 * Contact details for the export, keyed by customer id.
 *
 * The log table only stores `customer_id`, so an export on its own can't answer
 * "who was texted?". The caller resolves the ids it just exported into this
 * lookup; rows with no contact record still fall back to the number stored on
 * the record itself.
 */
export type ExportContact = { first_name: string | null; phone_number: string | null };
export type ExportContactLookup = ReadonlyMap<string, ExportContact>;

const cell = (value: string | null | undefined): string => {
  const raw = value ?? "";
  return /[",\n\r]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
};

export function buildLogCsv(
  rows: readonly ExportableLogRow[],
  contacts?: ExportContactLookup,
): string {
  const header = [
    "timestamp_utc",
    "timestamp_local",
    "action_type",
    "label",
    "status",
    "message",
    "customer_id",
    "customer_first_name",
    "customer_phone_number",
  ];
  const lines = rows.map((row) => {
    const contact = row.customer_id ? contacts?.get(row.customer_id) : undefined;
    return [
      row.created_at,
      new Date(row.created_at).toLocaleString(),
      row.action_type,
      logActionLabel(row.action_type),
      row.status,
      row.message_sent,
      row.customer_id,
      contact?.first_name ?? "",
      // Prefer the contact's number on file; otherwise the number this specific
      // record was sent to, so a deleted contact still shows who was reached.
      contact?.phone_number ?? row.recipient_phone ?? "",
    ]
      .map((v) => cell(typeof v === "string" ? v : v == null ? "" : String(v)))
      .join(",");
  });
  return [header.join(","), ...lines].join("\r\n");
}

export function activityLogCsvFilename(scope: string): string {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return `activity-log-${scope}-${stamp}.csv`;
}

export function downloadCsv(csv: string, scope: string): void {
  const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = activityLogCsvFilename(scope);
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
