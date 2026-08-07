// @vitest-environment jsdom
/**
 * Activity log rendering for opt-in prompt records.
 *
 * Two action types describe the texting opt-in prompt:
 *
 * - `opt_in_prompt`      — a prompt sent to a contact
 * - `opt_in_prompt_test` — a prompt sent to the business owner's own number
 *
 * These rows are the audit trail behind an SMS-consent claim, so whenever they
 * exist the log must render them faithfully: correct label + tooltip, correct
 * status dot, the message body, an exact HH:MM:SS timestamp derived from
 * created_at, the copyable dispatch line, and the telephony/template fields in
 * the expandable details drawer.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

type Row = {
  id: string;
  action_type: string;
  message_sent: string | null;
  created_at: string;
  status: string | null;
  customer_id: string | null;
  recipient_phone?: string | null;
  twilio_message_sid?: string | null;
  prompt_template?: string | null;
  prompt_template_hash?: string | null;
  prompt_cooldown_minutes?: number | null;
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

const { LogAction } = await import("@/lib/log-action-types");
const { logActionDescription, logActionDot, logActionLabel } = await import("@/lib/log-action-presentation");
const { DispatchLog } = await import("./DispatchLog");

const PROMPT_AT = "2026-08-06T15:04:05.000Z";
const TEST_AT = "2026-08-06T15:02:01.000Z";

const PROMPT_BODY = "Temaro: reply YES to get texts from Acme Plumbing. Msg&data rates may apply. Reply STOP to opt out.";

function promptRow(): Row {
  return {
    id: "row-opt-in-prompt",
    action_type: LogAction.opt_in_prompt,
    message_sent: PROMPT_BODY,
    created_at: PROMPT_AT,
    status: "sent",
    customer_id: null,
    recipient_phone: "+14155550123",
    twilio_message_sid: "SM11111111111111111111111111111111",
    prompt_template: "Temaro: reply YES to get texts from {business}.",
    prompt_template_hash: "abc123hash",
    prompt_cooldown_minutes: 60,
  };
}

function testRow(): Row {
  return {
    id: "row-opt-in-prompt-test",
    action_type: LogAction.opt_in_prompt_test,
    message_sent: PROMPT_BODY,
    created_at: TEST_AT,
    status: "delivered",
    customer_id: null,
    recipient_phone: "+14155559999",
    twilio_message_sid: "SM22222222222222222222222222222222",
    prompt_template: "Temaro: reply YES to get texts from {business}.",
    prompt_template_hash: "abc123hash",
    prompt_cooldown_minutes: 60,
  };
}

/** The exact clock text the row is expected to render for an ISO timestamp. */
function expectedTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function renderLog() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <DispatchLog limit={100} />
    </QueryClientProvider>,
  );
}

function rowFor(label: string): HTMLElement {
  const list = screen.getByRole("list");
  const labelEl = within(list).getByText(label, { selector: "span" });
  return labelEl.closest('[role="listitem"]') as HTMLElement;
}

function dotOf(rowEl: HTMLElement): HTMLElement {
  const dot = rowEl.querySelector("span.rounded-full.h-2, span.h-2.rounded-full");
  if (!dot) throw new Error("row has no status dot");
  return dot as HTMLElement;
}

beforeEach(() => {
  searchState = {};
  window.localStorage.removeItem("temaro-activity-log-types");
  FIXTURES = [promptRow(), testRow()];
});

afterEach(() => cleanup());

describe("Activity log — opt_in_prompt and opt_in_prompt_test rows", () => {
  it("renders both rows with their label, tooltip, dot token, and message body", async () => {
    renderLog();
    await waitFor(() => expect(screen.getByText("2 loaded")).toBeTruthy());

    for (const t of [LogAction.opt_in_prompt, LogAction.opt_in_prompt_test] as const) {
      const label = logActionLabel(t);
      const rowEl = rowFor(label);
      expect(rowEl, `no rendered row for ${t}`).toBeTruthy();

      const labelEl = within(rowEl).getByText(label);
      expect(labelEl.getAttribute("title")).toBe(logActionDescription(t));
      expect(dotOf(rowEl).className).toContain(logActionDot(t));
      expect(within(rowEl).getByText(PROMPT_BODY)).toBeTruthy();
    }

    // The two types stay visually distinguishable from each other.
    expect(logActionDot(LogAction.opt_in_prompt)).not.toBe(logActionDot(LogAction.opt_in_prompt_test));
  });

  it("renders each row's timestamp from created_at with second precision", async () => {
    renderLog();
    await waitFor(() => expect(screen.getByText("2 loaded")).toBeTruthy());

    const promptEl = rowFor(logActionLabel(LogAction.opt_in_prompt));
    expect(within(promptEl).getByText(expectedTime(PROMPT_AT))).toBeTruthy();

    const testEl = rowFor(logActionLabel(LogAction.opt_in_prompt_test));
    expect(within(testEl).getByText(expectedTime(TEST_AT))).toBeTruthy();

    // Distinct source timestamps must not collapse to the same rendered clock.
    expect(expectedTime(PROMPT_AT)).not.toBe(expectedTime(TEST_AT));
  });

  it("copies a dispatch-log line containing the date, label, and message", async () => {
    const writeText = vi.fn((_text: string) => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const user = userEvent.setup();

    renderLog();
    await waitFor(() => expect(screen.getByText("2 loaded")).toBeTruthy());

    const rowEl = rowFor(logActionLabel(LogAction.opt_in_prompt));
    await user.click(within(rowEl).getByRole("button", { name: "Copy dispatch line" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const line = writeText.mock.calls[0]![0] as unknown as string;
    expect(line).toContain(logActionLabel(LogAction.opt_in_prompt));
    expect(line).toContain(PROMPT_BODY);
    expect(line).toContain(
      new Date(PROMPT_AT).toLocaleString([], {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }),
    );
    // Dispatch format: "<time> · <LABEL> · <detail>".
    expect(line.split(" · ").length).toBeGreaterThanOrEqual(3);
  });

  it("exposes recipient, message SID, template, hash, and cooldown in the details drawer", async () => {
    const user = userEvent.setup();
    renderLog();
    await waitFor(() => expect(screen.getByText("2 loaded")).toBeTruthy());

    const rowEl = rowFor(logActionLabel(LogAction.opt_in_prompt));
    const toggle = within(rowEl).getByRole("button", { name: "Show dispatch details" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await user.click(toggle);

    await waitFor(() => expect(toggle.getAttribute("aria-expanded")).toBe("true"));
    const details = document.getElementById("log-details-row-opt-in-prompt") as HTMLElement;
    expect(details).toBeTruthy();
    expect(details.textContent).toContain("+14155550123");
    expect(details.textContent).toContain("SM11111111111111111111111111111111");
    expect(details.textContent).toContain("abc123hash");
    expect(details.textContent).toContain("60 min");
    expect(details.textContent).toContain("{business}");
  });

  it("keeps only opt-in prompt rows when their filter chips are selected", async () => {
    const user = userEvent.setup();
    FIXTURES = [
      promptRow(),
      testRow(),
      {
        id: "row-other",
        action_type: LogAction.sms_inbound,
        message_sent: "YES",
        created_at: "2026-08-06T15:00:00.000Z",
        status: null,
        customer_id: null,
      },
    ];

    renderLog();
    await waitFor(() => expect(screen.getByText("3 loaded")).toBeTruthy());

    const promptLabel = logActionLabel(LogAction.opt_in_prompt);
    const testLabel = logActionLabel(LogAction.opt_in_prompt_test);
    const chips = screen.getByRole("group", { name: /filter/i });
    await user.click(within(chips).getByRole("button", { name: new RegExp(`^${promptLabel}$`) }));
    await user.click(within(chips).getByRole("button", { name: new RegExp(`^${testLabel}$`) }));

    await waitFor(() => expect(screen.getByText("2 loaded")).toBeTruthy());
    const list = screen.getByRole("list");
    expect(within(list).getByText(promptLabel, { selector: "span" })).toBeTruthy();
    expect(within(list).getByText(testLabel, { selector: "span" })).toBeTruthy();
    expect(within(list).queryByText(logActionLabel(LogAction.sms_inbound), { selector: "span" })).toBeNull();
  });

  it("renders nothing extra when no opt-in prompt rows exist", async () => {
    FIXTURES = [
      {
        id: "row-only-inbound",
        action_type: LogAction.sms_inbound,
        message_sent: "YES",
        created_at: "2026-08-06T15:00:00.000Z",
        status: null,
        customer_id: null,
      },
    ];

    renderLog();
    await waitFor(() => expect(screen.getByText("1 loaded")).toBeTruthy());

    const list = screen.getByRole("list");
    expect(within(list).queryByText(logActionLabel(LogAction.opt_in_prompt), { selector: "span" })).toBeNull();
    expect(within(list).queryByText(logActionLabel(LogAction.opt_in_prompt_test), { selector: "span" })).toBeNull();
  });
});
