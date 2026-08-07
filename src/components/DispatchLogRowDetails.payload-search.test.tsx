// @vitest-environment jsdom
/**
 * Payload search inside the Activity log details drawer.
 *
 * Webhook and status-refresh payloads can be dozens of lines, so the drawer's
 * search box must narrow the payload to matching lines, number them, highlight
 * the hits, announce a match count, and restore the full payload when cleared.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { DispatchLogRowDetails, searchPayloadLines } from "./DispatchLogRowDetails";

const PAYLOAD = JSON.stringify(
  { CallSid: "CA123", From: "+14155550123", To: "+14155559999", CallStatus: "no-answer" },
  null,
  2,
);

function renderDrawer(message: string | null = PAYLOAD) {
  return render(
    <DispatchLogRowDetails
      row={{
        id: "row-1",
        action_type: "missed_call",
        status: "received",
        message_sent: message,
        created_at: "2026-08-06T15:04:05.000Z",
        customer_id: null,
      }}
    />,
  );
}

afterEach(() => cleanup());

describe("searchPayloadLines", () => {
  it("returns matching lines with 1-based line numbers, case-insensitively", () => {
    const hits = searchPayloadLines(PAYLOAD, "callstatus");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.content).toContain("CallStatus");
    expect(hits[0]!.line).toBe(PAYLOAD.split("\n").findIndex((l) => l.includes("CallStatus")) + 1);
  });

  it("returns nothing for a blank query", () => {
    expect(searchPayloadLines(PAYLOAD, "   ")).toEqual([]);
  });
});

describe("Activity log details drawer — payload search", () => {
  it("filters the payload to matching lines and highlights the match", async () => {
    renderDrawer();
    const box = screen.getByLabelText("Search payload fields");
    await userEvent.type(box, "sid");

    const list = screen.getByRole("list");
    // Only the CallSid line survives the filter.
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    expect(within(list).getAllByRole("listitem")[0]!.textContent).toContain("CallSid");
    expect(list.querySelector("mark")?.textContent?.toLowerCase()).toBe("sid");
    expect(screen.getByRole("status").textContent).toBe("1 matching line");
  });

  it("pluralizes the match count when several lines match", async () => {
    renderDrawer();
    await userEvent.type(screen.getByLabelText("Search payload fields"), "+1415555");
    expect(screen.getByRole("status").textContent).toBe("2 matching lines");
  });

  it("explains when nothing in the payload matches", async () => {
    renderDrawer();
    await userEvent.type(screen.getByLabelText("Search payload fields"), "zzzz");
    expect(screen.getByRole("status").textContent).toBe("No matching payload lines");
    expect(screen.getByText(/Nothing in this payload matches/)).toBeTruthy();
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("restores the full payload when the search is cleared", async () => {
    renderDrawer();
    const box = screen.getByLabelText("Search payload fields");
    await userEvent.type(box, "sid");
    await userEvent.click(screen.getByRole("button", { name: "Clear payload search" }));

    expect(screen.queryByRole("list")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("");
    const pre = document.querySelector("pre");
    expect(pre?.textContent).toBe(PAYLOAD);
  });

  it("clears the search with Escape", async () => {
    renderDrawer();
    const box = screen.getByLabelText("Search payload fields");
    await userEvent.type(box, "sid{Escape}");
    expect((box as HTMLInputElement).value).toBe("");
    expect(document.querySelector("pre")?.textContent).toBe(PAYLOAD);
  });

  it("hides the search box when there is no payload", () => {
    renderDrawer(null);
    expect(screen.queryByLabelText("Search payload fields")).toBeNull();
  });
});
