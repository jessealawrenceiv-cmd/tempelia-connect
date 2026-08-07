// @vitest-environment jsdom
/**
 * Tooltip accessibility for the automation status badge.
 *
 * The badge trigger must expose the status panel to keyboard users: focusing it
 * opens the panel, ARIA attributes (aria-expanded / aria-describedby /
 * aria-hidden / aria-label) track the open state, Enter and ArrowDown move
 * focus inside, and closing returns focus to the trigger.
 */
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AutomationBadge, TooltipCloseButton } from "./AutomationBadge";

afterEach(cleanup);

function Harness() {
  return (
    <div>
      <button type="button">before</button>
      <AutomationBadge
        state="active"
        activeCount={3}
        tooltip={
          <div>
            <span>Missed-call auto-text</span>
            <TooltipCloseButton />
          </div>
        }
      />
    </div>
  );
}

const trigger = () => screen.getByRole("button", { name: /Automation status/i });
const panel = () => document.getElementById(trigger().getAttribute("aria-controls")!)!;
const closeBtn = () => screen.getByRole("button", { name: "Close" });

describe("AutomationBadge tooltip accessibility", () => {
  it("is collapsed and hidden before any interaction", () => {
    render(<Harness />);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(trigger().getAttribute("aria-describedby")).toBeNull();
    expect(panel().getAttribute("aria-hidden")).toBe("true");
    expect(panel().hasAttribute("hidden")).toBe(true);
    expect(trigger().getAttribute("aria-label")).toMatch(/Show details/i);
  });

  it("opens on keyboard focus and updates ARIA attributes", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.tab(); // "before"
    await user.tab(); // badge trigger
    expect(document.activeElement).toBe(trigger());

    await waitFor(() => expect(trigger().getAttribute("aria-expanded")).toBe("true"));
    expect(trigger().getAttribute("aria-describedby")).toBe(panel().id);
    expect(trigger().getAttribute("aria-controls")).toBe(panel().id);
    expect(trigger().getAttribute("aria-haspopup")).toBe("true");
    expect(trigger().getAttribute("aria-label")).toMatch(/Hide details/i);
    expect(panel().hasAttribute("hidden")).toBe(false);
    expect(panel().getAttribute("aria-hidden")).toBe("false");
    expect(panel().getAttribute("aria-label")).toBe("Advanced automation details");
    expect(panel().getAttribute("role")).toBe("group");
    expect(screen.getByText("Missed-call auto-text")).toBeTruthy();
    expect(trigger().getAttribute("data-opened-by")).toBe("keyboard");
  });

  it("moves focus into the tooltip with Enter and with ArrowDown", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    trigger().focus();

    await user.keyboard("{Enter}");
    await waitFor(() => expect(document.activeElement).toBe(closeBtn()));
    expect(trigger().getAttribute("aria-expanded")).toBe("true");

    trigger().focus();
    await user.keyboard("{ArrowDown}");
    await waitFor(() => expect(document.activeElement).toBe(closeBtn()));
  });

  it("closes on Escape, resets ARIA, and returns focus to the trigger", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    trigger().focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(document.activeElement).toBe(closeBtn()));

    await user.keyboard("{Escape}");

    await waitFor(() => expect(trigger().getAttribute("aria-expanded")).toBe("false"));
    expect(trigger().getAttribute("aria-describedby")).toBeNull();
    expect(panel().getAttribute("aria-hidden")).toBe("true");
    expect(trigger().getAttribute("aria-label")).toMatch(/Show details/i);
    await waitFor(() => expect(document.activeElement).toBe(trigger()));
  });

  it("closes via the tooltip Close button and restores focus", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    trigger().focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(document.activeElement).toBe(closeBtn()));

    await user.click(closeBtn());

    await waitFor(() => expect(trigger().getAttribute("aria-expanded")).toBe("false"));
    await waitFor(() => expect(document.activeElement).toBe(trigger()));
  });

  it("stays open while focus lives inside the tooltip", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    trigger().focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(document.activeElement).toBe(closeBtn()));
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(panel().hasAttribute("hidden")).toBe(false);
  });

  it("renders a plain badge with no tooltip ARIA when no tooltip is provided", () => {
    render(<AutomationBadge state="manual" />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("Manual")).toBeTruthy();
  });
});
