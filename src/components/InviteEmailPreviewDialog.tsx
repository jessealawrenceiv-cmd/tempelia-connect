import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  buildInviteEmail,
  daysUntil,
  formatExpiry,
  INVITE_WINDOW_DAYS,
} from "@/lib/invite-email";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  invitedEmail: string;
  businessName: string;
  /** Existing invite expiry; omit to project a fresh window for an unsent invite. */
  expiresAt?: string | null;
  /** Rendered only when the invite has not been created yet. */
  onConfirm?: () => void;
  confirmLabel?: string;
  confirmPending?: boolean;
};

/**
 * Shows the exact email copy and expiry details for a staff invite before it
 * goes out, so the owner can verify the address and window first.
 */
export function InviteEmailPreviewDialog({
  open,
  onOpenChange,
  invitedEmail,
  businessName,
  expiresAt,
  onConfirm,
  confirmLabel = "Send invite",
  confirmPending,
}: Props) {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const email = buildInviteEmail({ invitedEmail, businessName, origin, expiresAt });

  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${what} copied.`);
    } catch {
      toast.error("Could not copy to clipboard.");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-lg">Invite email preview</DialogTitle>
          <DialogDescription className="text-xs">
            This is the exact content and expiry the invited address will receive.
          </DialogDescription>
        </DialogHeader>

        <dl className="mono grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px]">
          <dt className="uppercase tracking-widest text-muted-foreground">To</dt>
          <dd className="truncate text-paper">{email.to || "—"}</dd>
          <dt className="uppercase tracking-widest text-muted-foreground">From</dt>
          <dd className="truncate text-moss">{email.from}</dd>
          <dt className="uppercase tracking-widest text-muted-foreground">Subject</dt>
          <dd className="text-paper">{email.subject}</dd>
          <dt className="uppercase tracking-widest text-muted-foreground">Expires</dt>
          <dd className="text-violet">
            {formatExpiry(email.expiresAt)} · {daysUntil(email.expiresAt)}d left
            {expiresAt ? "" : ` (projected ${INVITE_WINDOW_DAYS}-day window)`}
          </dd>
        </dl>

        <pre className="mt-1 whitespace-pre-wrap rounded-sm border border-border bg-background p-3 text-[11px] leading-relaxed text-foreground">
          {email.body}
        </pre>

        <p className="text-xs text-muted-foreground">
          There is no secret link in this email — access is granted only when the recipient signs in
          with <span className="mono">{email.to || "that address"}</span> and confirms it.
        </p>

        <div className="flex flex-wrap justify-end gap-2">
          <button
            onClick={() => copy(email.body, "Email body")}
            className="rounded-sm border border-border px-3 py-1.5 text-[10px] uppercase tracking-widest text-muted-foreground hover:text-foreground"
          >
            Copy body
          </button>
          <button
            onClick={() => copy(`${email.subject}\n\n${email.body}`, "Subject and body")}
            className="rounded-sm border border-border px-3 py-1.5 text-[10px] uppercase tracking-widest text-muted-foreground hover:text-foreground"
          >
            Copy subject + body
          </button>
          {onConfirm && (
            <button
              onClick={onConfirm}
              disabled={confirmPending}
              className="rounded-sm bg-violet px-4 py-1.5 text-[10px] uppercase tracking-widest text-paper disabled:opacity-50"
            >
              {confirmPending ? "Sending…" : confirmLabel}
            </button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
