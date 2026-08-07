import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AutomationBadge, TooltipCloseButton } from "./AutomationBadge";

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

describe("AutomationBadge tooltip accessibility", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("is collapsed and hidden before any interaction", () => {
    render(<Harness />);
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
    expect(trigger()).not.toHaveAttribute("aria-describedby");
    expect(panel()).toHaveAttribute("aria-hidden", "true");
    expect(panel()).toHaveAttribute("hidden");
  });

  it("opens on keyboard focus and updates ARIA attributes", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.tab(); // "before"
    await user.tab(); // badge trigger
    expect(trigger()).toHaveFocus();

    await waitFor(() => expect(trigger()).toHaveAttribute("aria-expanded", "true"));
    expect(trigger()).toHaveAttribute("aria-describedby", panel().id);
    expect(trigger()).toHaveAttribute("aria-controls", panel().id);
    expect(trigger()).toHaveAttribute("aria-haspopup", "true");
    expect(trigger().getAttribute("aria-label")).toMatch(/Hide details/i);
    expect(panel()).not.toHaveAttribute("hidden");
    expect(panel()).toHaveAttribute("aria-hidden", "false");
    expect(panel()).toHaveAttribute("aria-label", "Advanced automation details");
    expect(screen.getByText("Missed-call auto-text")).toBeVisible();
    expect(trigger()).toHaveAttribute("data-opened-by", "keyboard");
  });

  it("moves focus into the tooltip with Enter and ArrowDown", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    trigger().focus();

    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Close" })).toHaveFocus()
    );
    expect(trigger()).toHaveAttribute("aria-expanded", "true");

    trigger().focus();
    await user.keyboard("{ArrowDown}");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Close" })).toHaveFocus()
    );
  });

  it("closes on Escape, resets ARIA, and returns focus to the trigger", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    trigger().focus();
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Close" })).toHaveFocus()
    );

    await user.keyboard("{Escape}");

    await waitFor(() => expect(trigger()).toHaveAttribute("aria-expanded", "false"));
    expect(trigger()).not.toHaveAttribute("aria-describedby");
    expect(panel()).toHaveAttribute("aria-hidden", "true");
    expect(trigger().getAttribute("aria-label")).toMatch(/Show details/i);
    await waitFor(() => expect(trigger()).toHaveFocus());
  });

  it("closes via the tooltip Close button and restores focus", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    trigger().focus();
    await user.keyboard("{Enter}");
    const close = await screen.findByRole("button", { name: "Close" });
    await waitFor(() => expect(close).toHaveFocus());

    await user.click(close);

    await waitFor(() => expect(trigger()).toHaveAttribute("aria-expanded", "false"));
    await waitFor(() => expect(trigger()).toHaveFocus());
  });

  it("stays open while focus is inside the tooltip", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    trigger().focus();
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Close" })).toHaveFocus()
    );
    // Blur of the trigger must not collapse the panel.
    expect(trigger()).toHaveAttribute("aria-expanded", "true");
  });

  it("renders a plain badge with no tooltip ARIA when no tooltip is provided", () => {
    render(<AutomationBadge state="manual" />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("Manual")).toBeVisible();
  });
});
