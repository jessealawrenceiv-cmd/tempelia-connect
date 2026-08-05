import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export type DepositInlinePreviewTarget = {
  kind: "quote" | "customer";
  shortId: string;
  href: string;
};

/**
 * Inline (in-app) preview of the quote detail page or the customer-facing quote
 * page, rendered in a modal iframe so the deposit timeline stays put.
 */
export function DepositInlinePreviewDialog({
  target,
  onClose,
}: {
  target: DepositInlinePreviewTarget | null;
  onClose: () => void;
}) {
  const isQuote = target?.kind === "quote";
  return (
    <Dialog open={!!target} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-4xl border-border bg-card p-0">
        <DialogHeader className="border-b border-border px-4 py-3">
          <DialogTitle className="mono text-[11px] uppercase tracking-widest text-muted-foreground">
            {isQuote ? "quote details" : "customer view"} · {target?.shortId ?? ""}
          </DialogTitle>
        </DialogHeader>
        {target && (
          <div className="px-4 pb-4">
            <iframe
              key={target.href}
              src={target.href}
              title={`${isQuote ? "Quote details" : "Customer view"} preview for ${target.shortId}`}
              className="h-[70vh] w-full rounded-sm border border-border bg-background"
            />
            <div className="mono pt-2 text-right text-[10px] uppercase tracking-widest">
              <a
                href={target.href}
                target="_blank"
                rel="noreferrer"
                className="text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-paper"
              >
                open in new tab ↗
              </a>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
