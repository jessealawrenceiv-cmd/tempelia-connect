// @vitest-environment jsdom
/**
 * Exhaustive presentation coverage for every allowed `logs.action_type`.
 *
 * The activity log conveys record type with a coloured status dot plus a
 * tooltip on the label. Both come from LOG_ACTION_PRESENTATION, so this suite
 * renders one real log row per whitelisted action type and asserts:
 *
 * - the dot carries the mapped Tailwind class, and that class resolves to a
 *   real design token (no hard-coded hex, no undefined `bg-*` colour),
 * - the label text and its `title` tooltip match the presentation map,
 * - status_refresh rows override the dot per outcome (updated / already_current
 *   / failed),
 * - filter chips expose the same description as their tooltip.
 *
 * Adding a type to the DB CHECK constraint and regenerating the enum makes this
 * suite fail until label/dot/description are filled in.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";

type Row = {
  id: string;
  action_type: string;
  message_sent: string | null;
  created_at: string;
  status: string | null;
  customer_id: string | null;
};

let FIXTURES: Row[] = [];

function makeBuilder(table: string) {
  const state: { types: string[] | null; limit: number } = { types: null, limit: 100 };
  const b: Record<string, unknown> = {
    select: () => b,
    order: () => b,
    limit: (n: number) => {
      state.limit = n;
      return b;
    },
    gte: () => b,
    lte: () => b,
    lt: () => b,
    gt: () => b,
    or: () => b,
    eq: () => b,
    in: (_col: string, values: string[]) => {
      state.types = values;
      return b;
    },
    returns: () => {
      let rows = table === "logs" ? [...FIXTURES] : [];
      if (state.types) rows = rows.filter((r) => state.types!.includes(r.action_type));
      return Promise.resolve({ data: rows.slice(0, state.limit), error: null });
    },
  };
  return b;
}

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: (table: string) => makeBuilder(table) },
}));

let searchState: Record<string, unknown> = {};
const subscribers = new Set<() => void>();

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children?: React.ReactNode }) => React.createElement("a", null, children),
  useNavigate: () => (opts: { search?: unknown }) => {
    const next =
      typeof opts.search === "function"
        ? (opts.search as (p: Record<string, unknown>) => Record<string, unknown>)(searchState)
        : ((opts.search as Record<string, unknown>) ?? {});
    const cleaned: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(next)) if (v !== undefined) cleaned[k] = v;
    searchState = cleaned;
    subscribers.forEach((fn) => fn());
  },
  useSearch: ({ select }: { select?: (s: Record<string, unknown>) => unknown }) => {
    const snapshot = React.useSyncExternalStore(
      (cb) => {
        subscribers.add(cb);
        return () => subscribers.delete(cb);
      },
      () => searchState,
      () => searchState,
    );
    return select ? select(snapshot) : snapshot;
  },
}));

const { LOG_ACTION_TYPES, LogAction } = await import("@/lib/log-action-types");
const { LOG_ACTION_PRESENTATION, LOG_ACTION_FILTER_ORDER, logActionDot, logActionLabel, logActionDescription } =
  await import("@/lib/log-action-presentation");
const { DispatchLog } = await import("./DispatchLog");

/**
 * Every dot class must map to a token defined in src/styles.css @theme, so a
 * typo'd or invented colour (e.g. "bg-violet") can never ship silently.
 */
const ALLOWED_DOT_CLASSES = new Set([
  "bg-primary",
  "bg-secondary",
  "bg-muted",
  "bg-muted-foreground",
  "bg-destructive",
  "bg-foreground",
  "bg-charcoal",
  "bg-paper",
  "bg-orange",
  "bg-steel",
  "bg-moss",
]);

function renderLog() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <DispatchLog limit={100} />
    </QueryClientProvider>,
  );
}

/** The row whose label matches `label`, from the rendered list. */
function rowFor(label: string): HTMLElement {
  const labelEl = screen.getByText(label, { selector: "span" });
  return labelEl.closest('[role="listitem"]') as HTMLElement;
}

/** The status dot inside a row: the small round span before the label. */
function dotOf(rowEl: HTMLElement): HTMLElement {
  const dot = rowEl.querySelector("span.rounded-full.h-2, span.h-2.rounded-full");
  if (!dot) throw new Error("row has no status dot");
  return dot as HTMLElement;
}

beforeEach(() => {
  searchState = {};
  window.localStorage.removeItem("temaro-activity-log-types");
  // One row per whitelisted action type, newest first. status_refresh gets a
  // neutral outcome here; the override cases are exercised separately.
  FIXTURES = LOG_ACTION_TYPES.map((t, i) => ({
    id: `row-${t}`,
    action_type: t,
    message_sent: t === LogAction.status_refresh || t === LogAction.automation_status_change ? "{}" : `${t} happened`,
    created_at: new Date(Date.UTC(2026, 7, 6, 10, 0, 0) - i * 60_000).toISOString(),
    status: t === LogAction.status_refresh ? "updated" : null,
    customer_id: null,
  }));
});

afterEach(() => cleanup());

describe("LOG_ACTION_PRESENTATION map integrity", () => {
  it("covers every generated action type with a label, description, and token-backed dot", () => {
    for (const t of LOG_ACTION_TYPES) {
      const p = LOG_ACTION_PRESENTATION[t];
      expect(p, `missing presentation for ${t}`).toBeTruthy();
      expect(p.label.length, `empty label for ${t}`).toBeGreaterThan(0);
      expect(p.description.length, `empty description for ${t}`).toBeGreaterThan(0);
      // Semantic tokens only — no arbitrary values or raw hex.
      expect(p.dot, `dot for ${t} is not a design token`).toMatch(/^bg-[a-z-]+$/);
      expect(ALLOWED_DOT_CLASSES.has(p.dot), `unknown dot token "${p.dot}" for ${t}`).toBe(true);
    }
    // Labels are unique, so a row's type is never ambiguous in the log.
    const labels = LOG_ACTION_TYPES.map((t) => LOG_ACTION_PRESENTATION[t].label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe("Activity log rows — dot colour and tooltip for every action type", () => {
  it("renders the mapped dot class and label tooltip for each type", async () => {
    renderLog();
    await waitFor(() => expect(screen.getByText(`${LOG_ACTION_TYPES.length} loaded`)).toBeTruthy());

    for (const t of LOG_ACTION_TYPES) {
      const label = logActionLabel(t);
      const rowEl = rowFor(label);
      expect(rowEl, `no rendered row for ${t}`).toBeTruthy();

      // Tooltip: the plain-language description hangs off the label.
      const labelEl = within(rowEl).getByText(label);
      expect(labelEl.getAttribute("title"), `tooltip mismatch for ${t}`).toBe(logActionDescription(t));

      // Dot colour: status_refresh is outcome-driven ("updated" here), every
      // other type uses its mapped class.
      const expectedDot = t === LogAction.status_refresh ? "bg-primary" : logActionDot(t);
      expect(dotOf(rowEl).className, `dot class mismatch for ${t}`).toContain(expectedDot);
    }
  });

  it.each([
    ["updated", "bg-primary"],
    ["already_current", "bg-steel"],
    ["failed", "bg-orange"],
  ])("colours a status_refresh row by outcome: %s -> %s", async (status, expectedDot) => {
    FIXTURES = [
      {
        id: "sr",
        action_type: LogAction.status_refresh,
        message_sent: "{}",
        created_at: "2026-08-06T10:00:00.000Z",
        status,
        customer_id: null,
      },
    ];
    renderLog();

    await waitFor(() => expect(screen.getByText("STATUS_REFRESH")).toBeTruthy());
    const rowEl = rowFor("STATUS_REFRESH");
    expect(dotOf(rowEl).className).toContain(expectedDot);
  });
});

describe("Filter chips — tooltip per action type", () => {
  it("gives every chip the mapped description as its title", async () => {
    renderLog();
    await waitFor(() => expect(screen.getByText(`${LOG_ACTION_TYPES.length} loaded`)).toBeTruthy());

    const fieldset = screen.getByText("Record type").closest("fieldset") as HTMLElement;
    const chips = within(fieldset)
      .getAllByRole("button")
      .filter((el) => el.hasAttribute("aria-pressed"));

    expect(chips).toHaveLength(LOG_ACTION_FILTER_ORDER.length);

    for (const t of LOG_ACTION_FILTER_ORDER) {
      const label = logActionLabel(t);
      const chip = chips.find((el) => el.textContent?.includes(label));
      expect(chip, `no chip for ${t}`).toBeTruthy();
      // New types append a "— newly added type" suffix; the description itself
      // must always be present.
      expect(chip!.getAttribute("title") ?? "").toContain(logActionDescription(t));
    }
  });
});
