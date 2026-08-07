/**
 * Activity log CSV export.
 *
 * The export exists so an owner can answer "who did we text, and when?" outside
 * the app — so the contact's first name and phone number must survive the trip,
 * including for records whose contact has since been deleted, and quoting must
 * hold up for names containing commas or quotes.
 */
import { describe, expect, it } from "vitest";
import { LogAction } from "./log-action-types";
import { buildLogCsv, type ExportContact, type ExportableLogRow } from "./activity-log-csv";

const row = (over: Partial<ExportableLogRow> = {}): ExportableLogRow => ({
  id: "r1",
  action_type: LogAction.missed_call_text,
  message_sent: "Sorry we missed you!",
  created_at: "2026-08-01T12:00:00.000Z",
  status: "sent",
  customer_id: "c1",
  ...over,
});

const contacts = (entries: Record<string, ExportContact>) => new Map(Object.entries(entries));

const parse = (csv: string) => csv.split("\r\n");

describe("buildLogCsv contact columns", () => {
  it("appends first name and phone number to the header", () => {
    const [header] = parse(buildLogCsv([row()]));
    expect(header).toBe(
      "timestamp_utc,timestamp_local,action_type,label,status,message,customer_id,customer_first_name,customer_phone_number",
    );
  });

  it("fills in the contact's name and number for the row's customer", () => {
    const csv = buildLogCsv(
      [row({ customer_id: "c1" })],
      contacts({ c1: { first_name: "Dana", phone_number: "+14155550123" } }),
    );
    const [, line] = parse(csv);
    expect(line).toContain("Dana");
    expect(line).toContain("+14155550123");
    expect(line?.endsWith("c1,Dana,+14155550123")).toBe(true);
  });

  it("maps each row to its own contact", () => {
    const csv = buildLogCsv(
      [row({ id: "r1", customer_id: "c1" }), row({ id: "r2", customer_id: "c2" })],
      contacts({
        c1: { first_name: "Dana", phone_number: "+14155550123" },
        c2: { first_name: "Sam", phone_number: "+14155550999" },
      }),
    );
    const [, first, second] = parse(csv);
    expect(first).toContain("Dana");
    expect(first).not.toContain("Sam");
    expect(second).toContain("Sam");
    expect(second).toContain("+14155550999");
  });

  it("falls back to the number on the record when the contact is gone", () => {
    const csv = buildLogCsv(
      [row({ customer_id: "deleted", recipient_phone: "+14155550777" })],
      contacts({}),
    );
    expect(parse(csv)[1]?.endsWith("deleted,,+14155550777")).toBe(true);
  });

  it("leaves both columns empty for records with no contact at all", () => {
    const csv = buildLogCsv([row({ customer_id: null, recipient_phone: null })]);
    expect(parse(csv)[1]?.endsWith(",,")).toBe(true);
  });

  it("prefers the contact record's number over the per-record recipient", () => {
    const csv = buildLogCsv(
      [row({ customer_id: "c1", recipient_phone: "+14155550000" })],
      contacts({ c1: { first_name: "Dana", phone_number: "+14155550123" } }),
    );
    expect(parse(csv)[1]).toContain("+14155550123");
    expect(parse(csv)[1]).not.toContain("+14155550000");
  });

  it("quotes names containing commas and escapes embedded quotes", () => {
    const csv = buildLogCsv(
      [row({ customer_id: "c1", message_sent: null })],
      contacts({ c1: { first_name: 'Dana, "Dee"', phone_number: "+14155550123" } }),
    );
    expect(parse(csv)[1]).toContain('"Dana, ""Dee"""');
    // The escaped name must not add stray columns.
    expect(parse(csv)).toHaveLength(2);
  });

  it("handles a missing contacts lookup without throwing", () => {
    expect(() => buildLogCsv([row()])).not.toThrow();
    expect(parse(buildLogCsv([row()]))[1]?.endsWith("c1,,")).toBe(true);
  });
});
