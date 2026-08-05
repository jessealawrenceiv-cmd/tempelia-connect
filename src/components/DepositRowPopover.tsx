import { useRef } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export type DepositRowPopoverProps = {
  rowId: string;
  quoteId: string;
  received: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  depositAtEvent: string;
  balanceAtEvent: string;
  quoteTotal: string;
  currentBalance: string;
  quoteHref: string;
  customerHref: string;
  onCopyShortId: () => void;
  onCopyShareLink: () => void;
};

/**
 * Deposit timeline row trigger + preview popover.
 *
 * Interaction contract (covered by DepositRowPopover.test.tsx):
 * - hover opens the popover without stealing focus
 * - Enter/Space on the focused trigger opens it and traps focus inside
 * - Escape closes it and returns focus to the exact trigger
 * - tab order inside: copy · open quote · customer view · copy share link
 */
export function DepositRowPopover({
  rowId,
  quoteId,
  received,
  open,
  onOpenChange,
  depositAtEvent,
  balanceAtEvent,
  quoteTotal,
  currentBalance,
  quoteHref,
  customerHref,
  onCopyShortId,
  onCopyShareLink,
}: DepositRowPopoverProps) {
  const openModeRef = useRef<"hover" | "keyboard" | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverFocusedRef = useRef(false);
  const shortId = quoteId.slice(0, 8);

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          if (openModeRef.current === "keyboard" || popoverFocusedRef.current) {
            requestAnimationFrame(() => triggerRef.current?.focus());
          }
          openModeRef.current = null;
          popoverFocusedRef.current = false;
        }
        onOpenChange(o);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          ref={triggerRef}
          aria-label={`Preview quote ${shortId} deposit details`}
          onPointerDown={() => {
            openModeRef.current = "keyboard";
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              openModeRef.current = "keyboard";
              onOpenChange(true);
            }
            if (e.key === "Escape") onOpenChange(false);
          }}
          onMouseEnter={() => {
            if (open) return;
            openModeRef.current = "hover";
            onOpenChange(true);
          }}
          onMouseLeave={() => {
            if (openModeRef.current !== "hover") return;
            onOpenChange(false);
          }}
          className={`rounded-sm underline decoration-dotted underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
            received ? "text-moss" : "text-orange"
          }`}
        >
          {received ? "deposit received" : "deposit undone"}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        role="dialog"
        aria-labelledby={`deposit-preview-title-${rowId}`}
        aria-describedby={`deposit-preview-summary-${rowId}`}
        className="w-64 space-y-1 border-border bg-card p-3"
        onOpenAutoFocus={(e) => {
          // Hover-opened popovers must not steal focus; keyboard/click opens trap focus.
          if (openModeRef.current === "hover") e.preventDefault();
        }}
        onFocusCapture={() => {
          // Once focus moves inside the popover, treat it as a keyboard interaction
          // so Escape/click-outside returns focus to the trigger.
          popoverFocusedRef.current = true;
          openModeRef.current = "keyboard";
        }}
        onEscapeKeyDown={() => onOpenChange(false)}
        onMouseEnter={() => {
          if (openModeRef.current === "hover") onOpenChange(true);
        }}
        onMouseLeave={() => {
          if (openModeRef.current !== "hover") return;
          onOpenChange(false);
        }}
      >
        <h3
          id={`deposit-preview-title-${rowId}`}
          className="mono text-[10px] uppercase tracking-widest text-muted-foreground"
        >
          quote preview
        </h3>

        <div className="flex items-center gap-2">
          <div className="mono text-[11px] text-foreground">short id {shortId}</div>
          <button
            type="button"
            onClick={onCopyShortId}
            aria-label={`Copy quote short ID ${shortId}`}
            className="mono rounded-sm border border-border px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-muted-foreground hover:border-primary hover:text-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            copy
          </button>
        </div>
        <dl
          id={`deposit-preview-summary-${rowId}`}
          className="mono space-y-1 text-[11px] text-muted-foreground"
        >
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground">deposit at event</dt>
            <dd className="text-paper">{depositAtEvent}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground">balance at event</dt>
            <dd className="text-paper">{balanceAtEvent}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground">quote total</dt>
            <dd className="text-paper">{quoteTotal}</dd>
          </div>
          <div className="flex justify-between gap-2 border-t border-border/60 pt-1 text-violet">
            <dt>current balance</dt>
            <dd className="text-paper">{currentBalance}</dd>
          </div>
        </dl>

        <div className="flex flex-wrap gap-2 pt-1">
          <a
            href={quoteHref}
            target="_blank"
            rel="noreferrer"
            className="mono inline-flex items-center rounded-sm border border-violet/60 bg-violet/10 px-2 py-1 text-[10px] uppercase tracking-wider text-violet hover:bg-violet/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            open quote ↗
          </a>
          <a
            href={customerHref}
            target="_blank"
            rel="noreferrer"
            className="mono inline-flex items-center rounded-sm border border-steel/60 bg-steel/10 px-2 py-1 text-[10px] uppercase tracking-wider text-steel hover:bg-steel/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            customer view ↗
          </a>
          <button
            type="button"
            onClick={onCopyShareLink}
            aria-label={`Copy share link for deposit event ${rowId.slice(0, 8)}`}
            className="mono inline-flex items-center rounded-sm border border-border bg-background/60 px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground hover:border-primary hover:text-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            copy share link
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
