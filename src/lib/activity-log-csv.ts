import { logActionLabel } from "@/lib/log-action-presentation";

export const EXPORT_ROW_CAP = 5000;

/** Minimal structural type of the supabase query builder methods used by log filters. */
export type FilterableQuery = {
  gte(column: string, value: string): FilterableQuery;
  lte(column: string, value: string): FilterableQuery;
  lt(column: string, value: string): FilterableQuery;
  eq(column: string, value: string): FilterableQuery;
  in(column: string, values: readonly string[]): FilterableQuery;
  or(filters: string): FilterableQuery;
};

export type ExportableLogRow = {
  id: string;
  action_type: string;
  message_sent: string | null;
  created_at: string;
  status: string | null;
  customer_id: string | null;
};

const cell = (value: string | null | undefined): string => {
  const raw = value ?? "";
  return /[",\n\r]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
};

export function buildLogCsv(rows: readonly ExportableLogRow[]): string {
  const header = ["timestamp_utc", "timestamp_local", "action_type", "label", "status", "message", "customer_id"];
  const lines = rows.map((row) =>
    [
      row.created_at,
      new Date(row.created_at).toLocaleString(),
      row.action_type,
      logActionLabel(row.action_type),
      row.status,
      row.message_sent,
      row.customer_id,
    ]
      .map((v) => cell(typeof v === "string" ? v : v == null ? "" : String(v)))
      .join(","),
  );
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
