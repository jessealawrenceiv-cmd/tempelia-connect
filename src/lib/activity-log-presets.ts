import { pickLogActionTypes, type LogActionType } from "@/lib/log-action-query";

/**
 * A saved Activity-log filter combination. Stored in localStorage (per device):
 * these are personal shortcuts, not shared team config, so no backend row is
 * needed and they keep working offline.
 */
export type LogFilterPreset = {
  id: string;
  name: string;
  scope: "live" | "archive";
  types: LogActionType[];
  sort: "newest" | "oldest";
  q: string;
  customer: string;
  dateFrom?: string;
  dateTo?: string;
  statusRefreshOnly: boolean;
  failedOnly: boolean;
  origin: string;
};

export const LOG_PRESETS_STORAGE_KEY = "temaro-activity-log-presets";
export const MAX_LOG_PRESETS = 12;

const ORIGINS = ["all", "active", "this-device", "other-device", "backend"];
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Coerces an untrusted stored blob into a preset, or null when unusable. */
export function normalizePreset(raw: unknown): LogFilterPreset | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === "string" ? r.name.trim().slice(0, 40) : "";
  if (!name) return null;
  const day = (v: unknown) => (typeof v === "string" && DAY_RE.test(v) ? v : undefined);
  const from = day(r.dateFrom);
  const to = day(r.dateTo);
  return {
    id: typeof r.id === "string" && r.id ? r.id : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    scope: r.scope === "archive" ? "archive" : "live",
    types: Array.isArray(r.types) ? pickLogActionTypes(r.types).valid : [],
    sort: r.sort === "oldest" ? "oldest" : "newest",
    q: typeof r.q === "string" ? r.q.slice(0, 120) : "",
    customer: typeof r.customer === "string" ? r.customer.slice(0, 60) : "",
    ...(from ? { dateFrom: from } : {}),
    ...(from && to ? { dateTo: to } : {}),
    statusRefreshOnly: r.statusRefreshOnly === true,
    failedOnly: r.failedOnly === true,
    origin: typeof r.origin === "string" && ORIGINS.includes(r.origin) ? r.origin : "all",
  };
}

export function readStoredPresets(): LogFilterPreset[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(LOG_PRESETS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(normalizePreset)
      .filter((p): p is LogFilterPreset => p !== null)
      .slice(0, MAX_LOG_PRESETS);
  } catch {
    return [];
  }
}

export function writeStoredPresets(presets: LogFilterPreset[]) {
  if (typeof window === "undefined") return;
  try {
    if (presets.length === 0) window.localStorage.removeItem(LOG_PRESETS_STORAGE_KEY);
    else window.localStorage.setItem(LOG_PRESETS_STORAGE_KEY, JSON.stringify(presets.slice(0, MAX_LOG_PRESETS)));
  } catch {
    // Persistence is best-effort (private mode, quota).
  }
}

/** Short human summary shown under a preset name, e.g. "3 types · failed only". */
export function summarizePreset(p: LogFilterPreset): string {
  const parts: string[] = [];
  if (p.types.length > 0) parts.push(`${p.types.length} type${p.types.length === 1 ? "" : "s"}`);
  if (p.q) parts.push(`“${p.q}”`);
  if (p.customer) parts.push(`contact ${p.customer}`);
  if (p.dateFrom) parts.push(p.dateTo && p.dateTo !== p.dateFrom ? `${p.dateFrom}→${p.dateTo}` : p.dateFrom);
  if (p.statusRefreshOnly) parts.push("ACTIVE only");
  if (p.failedOnly) parts.push("failed only");
  if (p.origin !== "all") parts.push(p.origin);
  if (p.scope === "archive") parts.push("archive");
  if (p.sort === "oldest") parts.push("oldest first");
  return parts.length > 0 ? parts.join(" · ") : "No filters";
}
