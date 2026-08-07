import {
  createContext,
  forwardRef,
  memo,
  useContext,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { prefersReducedMotion } from "@/hooks/use-reduced-motion";

export const TooltipCloseContext = createContext<() => void>(() => {});

export function TooltipCloseButton({ children = "Close" }: { children?: React.ReactNode }) {
  const close = useContext(TooltipCloseContext);
  return (
    <button
      type="button"
      onClick={close}
      className="mt-2 rounded-sm border border-border px-2 py-1 uppercase tracking-widest text-muted-foreground hover:text-foreground kb-focus"
    >
      {children}
    </button>
  );
}

export type AutomationBadgeHandle = {
  contains: (el: Node | null) => boolean;
  restoreFocus: (el: HTMLElement | null) => void;
};

export type AutomationBadgeProps = {
  state: "active" | "manual" | "hold" | "off";
  label?: string;
  activeCount?: number;
  tooltip?: React.ReactNode;
};

export const AutomationBadge = memo(
  forwardRef<AutomationBadgeHandle, AutomationBadgeProps>(function AutomationBadge(
    { state, label, activeCount, tooltip },
    ref
  ) {
    const styles: Record<string, string> = {
      active: "border-moss/60 bg-moss/15 text-moss-ink",
      manual: "border-steel/60 bg-steel/15 text-steel-ink",
      hold: "border-orange/60 bg-orange/15 text-orange-ink",
      off: "border-border bg-muted/20 text-muted-foreground",
    };
    const defaults: Record<string, string> = {
      active: activeCount ? `${activeCount} active` : "Active",
      manual: "Manual",
      hold: "On hold",
      off: "Off",
    };
    const tooltipId = useId();
    const triggerId = useId();
    const containerRef = useRef<HTMLSpanElement>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const [open, setOpen] = useState(false);
    // true when the tooltip was opened by keyboard focus rather than pointer hover
    const [openedByKeyboard, setOpenedByKeyboard] = useState(false);
    // set while focus is handed back programmatically, so the trigger's onFocus doesn't reopen
    const suppressReopenRef = useRef(false);
    // true once focus has entered the tooltip during this open cycle.
    const focusStartedInsideRef = useRef(false);
    const returnFocusToTrigger = () => {
      const trigger = triggerRef.current;
      if (!trigger || !trigger.isConnected || document.activeElement === trigger) return;
      suppressReopenRef.current = true;
      if (prefersReducedMotion()) {
        trigger.focus();
        suppressReopenRef.current = false;
        return;
      }
      window.setTimeout(() => {
        trigger.focus();
        window.setTimeout(() => {
          suppressReopenRef.current = false;
        }, 0);
      }, 0);
    };

    useImperativeHandle(ref, () => ({
      contains: (el: Node | null) => containerRef.current?.contains(el ?? null) ?? false,
      restoreFocus: (el: HTMLElement | null) => {
        if (!el || !el.isConnected) return;
        if (document.activeElement === el) return;
        setOpen(true);
        const hand = () => {
          if ((el as HTMLButtonElement | null)?.disabled || !el.isConnected) return;
          el.focus();
        };
        if (prefersReducedMotion()) {
          window.requestAnimationFrame(hand);
          return;
        }
        window.setTimeout(() => {
          window.requestAnimationFrame(hand);
        }, 100);
      },
    }));

    useEffect(() => {
      if (!open) return;
      focusStartedInsideRef.current = false;
      const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Escape") {
          setOpen(false);
        }
      };
      const handleFocusIn = (e: FocusEvent) => {
        if (containerRef.current?.contains(e.target as Node)) {
          focusStartedInsideRef.current = true;
        }
      };
      const handlePointerDown = (e: PointerEvent | MouseEvent) => {
        const target = e.target as Node | null;
        if (target && containerRef.current?.contains(target)) return;
        setOpen(false);
      };
      document.addEventListener("keydown", handleKeyDown);
      document.addEventListener("focusin", handleFocusIn, true);
      document.addEventListener("pointerdown", handlePointerDown, true);
      return () => {
        document.removeEventListener("keydown", handleKeyDown);
        document.removeEventListener("focusin", handleFocusIn, true);
        document.removeEventListener("pointerdown", handlePointerDown, true);
      };
    }, [open]);

    // Whenever the tooltip closes, return focus to the trigger if focus originated inside it.
    useEffect(() => {
      if (!open) {
        setOpenedByKeyboard(false);
        if (focusStartedInsideRef.current) {
          focusStartedInsideRef.current = false;
          returnFocusToTrigger();
        }
      }
    }, [open]);

    const text = label ?? defaults[state];
    const badge = (
      <span
        className={`mono shrink-0 rounded-sm border px-2 py-1 text-[10px] uppercase tracking-widest ${styles[state]}`}
      >
        {state === "active" && (
          <span
            aria-hidden="true"
            className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-moss align-middle"
          />
        )}
        {text}
      </span>
    );

    if (!tooltip) return badge;

    const show = () => {
      if (suppressReopenRef.current) return;
      setOpen(true);
    };
    const hide = (e?: React.SyntheticEvent) => {
      if (containerRef.current?.contains(document.activeElement)) return;
      const next =
        "relatedTarget" in (e ?? {})
          ? ((e as React.FocusEvent).relatedTarget as Node | null)
          : null;
      if (!next || !containerRef.current?.contains(next)) {
        setOpen(false);
      }
    };
    const focusInsideTooltip = () => {
      window.setTimeout(() => {
        containerRef.current
          ?.querySelector<HTMLButtonElement>(`#${CSS.escape(tooltipId)} button`)
          ?.focus();
      }, 0);
    };

    return (
      <span ref={containerRef} className="relative shrink-0">
        <button
          id={triggerId}
          ref={triggerRef}
          type="button"
          aria-expanded={open}
          aria-controls={tooltipId}
          // The panel describes the trigger only while it is visible; a hidden
          // reference would otherwise be announced as an empty description.
          aria-describedby={open ? tooltipId : undefined}
          aria-haspopup="true"
          aria-label={`Automation status: ${text}. ${open ? "Hide details" : "Show details"}`}
          data-open={open ? "true" : "false"}
          data-opened-by={open ? (openedByKeyboard ? "keyboard" : "pointer") : undefined}
          className="cursor-help rounded-sm kb-focus"
          onMouseEnter={show}
          onMouseLeave={hide}
          // Keyboard focus opens the tooltip so its details are reachable without a pointer.
          onFocus={(e) => {
            if (suppressReopenRef.current) return;
            const keyboard =
              typeof e.currentTarget.matches === "function" &&
              (e.currentTarget.matches(":focus-visible") || !e.currentTarget.matches(":hover"));
            setOpenedByKeyboard(keyboard);
            setOpen(true);
          }}
          onBlur={hide}
          onClick={() => setOpen((o) => !o)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setOpen(true);
              setOpenedByKeyboard(true);
              focusInsideTooltip();
            }
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setOpen(true);
              setOpenedByKeyboard(true);
              focusInsideTooltip();
            }
          }}
        >
          {badge}
        </button>
        <span
          id={tooltipId}
          role="group"
          hidden={!open}
          aria-hidden={!open}
          aria-label="Advanced automation details"
          className={`mono absolute right-0 top-full z-20 mt-2 w-64 rounded-sm border border-border bg-card p-3 text-left text-[10px] uppercase tracking-widest text-muted-foreground shadow-lg ${open ? "block" : "hidden"}`}
          onMouseEnter={show}
          onMouseLeave={hide}
          onBlur={hide}
          onKeyDown={(e) => {
            const navKeys = ["Tab", "ArrowDown", "ArrowUp", "Home", "End"];
            if (!navKeys.includes(e.key)) return;
            const tooltipEl = containerRef.current?.querySelector<HTMLElement>(
              `#${CSS.escape(tooltipId)}`
            );
            const focusables = Array.from(
              tooltipEl?.querySelectorAll<HTMLElement>(
                "button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])"
              ) ?? []
            );
            if (focusables.length === 0) return;
            const first = focusables[0];
            const last = focusables[focusables.length - 1];
            const index = focusables.indexOf(document.activeElement as HTMLElement);

            if (e.key === "Tab") {
              if (e.shiftKey && document.activeElement === first) {
                e.preventDefault();
                last.focus();
              } else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault();
                first.focus();
              }
              return;
            }

            e.preventDefault();
            if (e.key === "Home") {
              first.focus();
            } else if (e.key === "End") {
              last.focus();
            } else if (e.key === "ArrowDown") {
              focusables[index < 0 ? 0 : (index + 1) % focusables.length].focus();
            } else if (e.key === "ArrowUp") {
              focusables[
                index < 0 ? focusables.length - 1 : (index - 1 + focusables.length) % focusables.length
              ].focus();
            }
          }}
        >
          <TooltipCloseContext.Provider value={() => setOpen(false)}>
            {tooltip}
          </TooltipCloseContext.Provider>
        </span>
      </span>
    );
  })
);
