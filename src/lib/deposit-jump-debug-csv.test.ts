import { describe, expect, it } from "vitest";
import {
  buildDepositJumpDebugCsv,
  depositJumpDebugCsvFilename,
} from "./deposit-jump-debug-csv";

const TS = Date.UTC(2026, 7, 5, 21, 30, 0);

describe("buildDepositJumpDebugCsv", () => {
  it("writes a header row only when there are no entries", () => {
    const csv = buildDepositJumpDebugCsv([]);
    expect(csv.split("\r\n")).toHaveLength(1);
    expect(csv).toContain("occurred_at_utc,event,outcome,correlation_id");
  });

  it("promotes payload fields to columns and keeps the raw payload", () => {
    const csv = buildDepositJumpDebugCsv([
      {
        ts: TS,
        event: "deposit_jump_recovery",
        correlationId: "corr-1",
        payload: {
          correlation_id: "corr-1",
          event_id: "evt-9",
          reason: "not_found",
          action: "return_to_top",
          attempt_index: 2,
          ms_since_first_miss: 4500,
          ms_since_miss: 900,
        },
      },
    ]);
    const [, row] = csv.split("\r\n");
    expect(row).toContain('"2026-08-05T21:30:00.000Z"');
    expect(row).toContain('"deposit_jump_recovery"');
    expect(row).toContain('"miss"');
    expect(row).toContain('"corr-1"');
    expect(row).toContain('"evt-9"');
    expect(row).toContain('"2"');
    expect(row).toContain('"4500"');
    expect(row).toContain("event_id");
  });

  it("marks a confirmed jump as success and blanks missing fields", () => {
    const csv = buildDepositJumpDebugCsv([
      { ts: TS, event: "deposit_jump_success", correlationId: null, payload: {} },
    ]);
    const row = csv.split("\r\n")[1];
    expect(row.startsWith('"2026-08-05T21:30:00.000Z","deposit_jump_success","success",""')).toBe(
      true,
    );
  });

  it("neutralizes formula injection and escapes quotes", () => {
    const csv = buildDepositJumpDebugCsv([
      {
        ts: TS,
        event: "deposit_jump_miss",
        correlationId: "=cmd()",
        payload: { reason: 'he said "no"' },
      },
    ]);
    expect(csv).toContain("\"'=cmd()\"");
    expect(csv).toContain('"he said ""no"""');
  });
});

describe("depositJumpDebugCsvFilename", () => {
  it("includes the quote id and a timestamp", () => {
    expect(depositJumpDebugCsvFilename("Q-1234", new Date(TS))).toBe(
      "deposit-jump-debug-Q-1234-2026-08-05-21-30-00.csv",
    );
  });
});
