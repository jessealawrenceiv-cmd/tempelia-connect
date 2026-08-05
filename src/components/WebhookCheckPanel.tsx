import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { runWebhookCheck, type CheckState, type WebhookCheckResult } from "@/lib/webhook-check.functions";

const stateColor: Record<CheckState, string> = {
  pass: "text-moss",
  warn: "text-orange",
  fail: "text-destructive",
};
const stateGlyph: Record<CheckState, string> = { pass: "OK", warn: "??", fail: "XX" };

export function WebhookCheckPanel() {
  const [result, setResult] = useState<WebhookCheckResult | null>(null);
  const run = useServerFn(runWebhookCheck);

  const check = useMutation({
    mutationFn: () => run({}),
    onSuccess: (r) => {
      setResult(r);
      if (r.overall === "pass") toast.success("Webhooks verified — inbound path is live.");
      else if (r.overall === "warn") toast.message("Check complete with warnings.");
      else toast.error("Webhook check found a problem.");
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Webhook check failed."),
  });

  return (
    <div className="panel p-6 md:col-span-2">
      <div className="label-eyebrow">Diagnostics</div>
      <h2 className="mt-1 text-xl">Inbound webhook check</h2>
      <p className="mt-2 text-xs text-muted-foreground">
        Verifies your number is wired to Temaro in Twilio, that the missed-call and SMS endpoints are
        live and validating signatures, and whether real inbound events have landed in the dispatch log.
        Read-only — nothing is sent and no charges apply.
      </p>

      <button
        onClick={() => check.mutate()}
        disabled={check.isPending}
        className="mt-4 rounded-sm bg-orange px-4 py-3 text-sm font-medium uppercase tracking-wider text-orange-foreground hover:opacity-90 disabled:opacity-50"
      >
        {check.isPending ? "Checking…" : "Run webhook check"}
      </button>

      {result && (
        <div className="mt-5 border-t border-border pt-4">
          <div className="mono flex flex-wrap items-center gap-3 text-[10px] uppercase tracking-widest text-muted-foreground">
            <span className={stateColor[result.overall]}>
              {result.overall === "pass" ? "All checks passed" : result.overall === "warn" ? "Passed with warnings" : "Problems found"}
            </span>
            <span>·</span>
            <span>{new Date(result.ranAt).toLocaleString()}</span>
            {result.phoneNumber && (
              <>
                <span>·</span>
                <span>{result.phoneNumber}</span>
              </>
            )}
          </div>

          <ul className="mt-3 space-y-2">
            {result.checks.map((c) => (
              <li key={c.id} className="flex gap-3 border-b border-border pb-2 last:border-0">
                <span className={`mono text-xs ${stateColor[c.state]}`}>[{stateGlyph[c.state]}]</span>
                <div className="min-w-0">
                  <div className="text-sm">{c.label}</div>
                  <div className="mono mt-0.5 break-words text-[11px] text-muted-foreground">{c.detail}</div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
