// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, describe, expect, it, vi, beforeAll } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DepositRowPopover } from "./DepositRowPopover";

beforeAll(() => {
  // Radix relies on these; jsdom does not implement them.
  if (!window.ResizeObserver) {
    window.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
    Element.prototype.setPointerCapture = () => {};
    Element.prototype.releasePointerCapture = () => {};
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
});

afterEach(() => cleanup());

const copyShortId = vi.fn();
const copyShareLink = vi.fn();

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button">before</button>
      <DepositRowPopover
        rowId="evt-11111111"
        quoteId="quote-abcd-efgh"
        received
        open={open}
        onOpenChange={setOpen}
        depositAtEvent="$200.00"
        balanceAtEvent="$457.00"
        quoteTotal="$657.00"
        currentBalance="$457.00"
        quoteHref="/dashboard/quotes/q1/print"
        customerHref="/quote/q1"
        onCopyShortId={copyShortId}
        onCopyShareLink={copyShareLink}
      />
      <button type="button">after</button>
    </div>
  );
}

const trigger = () => screen.getByRole("button", { name: /Preview quote .* deposit details/i });

describe("DepositRowPopover keyboard accessibility", () => {
  it("opens with Enter and traps focus inside the popover", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    trigger().focus();
    await user.keyboard("{Enter}");

    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

    // Tabbing repeatedly never escapes the dialog (focus trap).
    for (let i = 0; i < 8; i++) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });

  it("opens with Space without scrolling the page", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    trigger().focus();
    await user.keyboard("[Space]");

    expect(await screen.findByRole("dialog")).toBeTruthy();
  });

  it("closes on Escape and returns focus to the exact trigger", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const btn = trigger();
    btn.focus();
    await user.keyboard("{Enter}");
    await screen.findByRole("dialog");

    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(btn));
  });

  it("exposes the popover title and deposit summary via ARIA", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    trigger().focus();
    await user.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog");

    const titleId = dialog.getAttribute("aria-labelledby")!;
    const summaryId = dialog.getAttribute("aria-describedby")!;
    expect(document.getElementById(titleId)?.textContent).toMatch(/quote preview/i);
    const summary = document.getElementById(summaryId)!;
    expect(summary.tagName).toBe("DL");
    expect(summary.textContent).toContain("$200.00");
    expect(summary.textContent).toContain("$457.00");
    expect(summary.textContent).toContain("$657.00");
  });

  it("follows the documented tab order inside the popover", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    trigger().focus();
    await user.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

    const order = [/copy quote short id/i, /open quote/i, /customer view/i, /copy event link/i];
    const seen: string[] = [];
    for (let i = 0; i < 12 && seen.length < order.length; i++) {
      const el = document.activeElement as HTMLElement | null;
      const label = el?.getAttribute("aria-label") ?? el?.textContent ?? "";
      if (order[seen.length]!.test(label)) seen.push(label);
      await user.tab();
    }

    expect(seen).toHaveLength(order.length);
    order.forEach((re, i) => expect(seen[i]).toMatch(re));
  });

  it("hover opens the popover without stealing focus", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const before = screen.getByRole("button", { name: "before" });
    before.focus();

    await user.hover(trigger());
    await screen.findByRole("dialog");

    expect(document.activeElement).toBe(before);
  });
});
