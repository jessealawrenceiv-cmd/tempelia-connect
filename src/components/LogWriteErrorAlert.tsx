import { AlertTriangle } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { LogActionTypeViolationDisplay } from "@/lib/log-action-violation";

/**
 * Inline error for a rejected activity-log write. Shows the rejected
 * action_type and the allowed action_type hints.
 */
export function LogWriteErrorAlert({
  violation,
  onDismiss,
}: {
  violation: LogActionTypeViolationDisplay | null;
  onDismiss?: () => void;
}) {
  if (!violation) return null;

  return (
    <Alert variant="destructive" role="alert" aria-live="assertive" data-testid="log-write-error">
      <AlertTriangle className="size-4" aria-hidden="true" />
      <AlertTitle>{violation.title}</AlertTitle>
      <AlertDescription className="space-y-2">
        <p>{violation.description}</p>
        <p className="text-xs">
          <span className="font-medium">Allowed action types:</span>{" "}
          <span className="font-mono">{violation.allowed.join(", ")}</span>
        </p>
        <details className="text-xs">
          <summary className="cursor-pointer">Technical details</summary>
          <code className="mt-1 block break-words font-mono">{violation.technical}</code>
        </details>
        {onDismiss ? (
          <Button variant="outline" size="sm" onClick={onDismiss}>
            Dismiss
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
