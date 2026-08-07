import { createFileRoute, redirect } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/AppShell";
import { requireAdminAccess } from "@/lib/admin.functions";
import { LOG_ACTION_PRESENTATION } from "@/lib/log-action-presentation";
import {
  getLogActionDiagnostics,
  runLogActionDriftCheck,
  type LogActionDiagnostics,
} from "@/lib/log-action-diagnostics.functions";
import { Check, Copy, Database, Download, RefreshCw, ScrollText, ShieldAlert } from "lucide-react";
import {
  actionTypesFilename,
  buildActionTypesJson,
  buildActionTypesSql,
  downloadTextFile,
} from "@/lib/action-type-export";
import { DriftHistoryPanel } from "@/components/DriftHistoryPanel";

export const Route = createFileRoute("/_authenticated/dashboard/admin/log-actions")({
  // Server-side role gate: the operator check happens on the server from the
  // caller's bearer token, so navigating straight to this URL cannot bypass it.
  beforeLoad: async () => {
    try {
      await requireAdminAccess();
    } catch {
      throw redirect({ to: "/dashboard" });
    }
  },
  head: () => ({
    meta: [
      { title: "Action type diagnostics · Temaro operator" },
      {
        name: "description",
        content:
          "Operator diagnostics for the generated activity-log action_type enum, drift test results, and the database CHECK constraint.",
      },
      { property: "og:title", content: "Action type diagnostics · Temaro operator" },
      {
        property: "og:description",
        content: "Generated action_type enum values, last drift check, and the live database constraint.",
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AdminLogActionsPage,
});

const fmtWhen = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

function AdminLogActionsPage() {
  const getFn = useServerFn(getLogActionDiagnostics);
  const runFn = useServerFn(runLogActionDriftCheck);
  const queryClient = useQueryClient();
  const [copied, setCopied] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ["admin", "log-action-diagnostics"],
    queryFn: () => getFn(),
    retry: false,
  });

  const check = useMutation({
    mutationFn: () => runFn(),
    onSuccess: (result: LogActionDiagnostics) => {
      queryClient.setQueryData(["admin", "log-action-diagnostics"], result);
      toast[result.matched ? "success" : "error"](
        result.matched ? "Drift check passed" : "Drift detected",
        { description: result.lastRun?.detail ?? undefined },
      );
    },
    onError: (e: Error) => toast.error("Drift check failed", { description: e.message }),
  });

  if (error) {
    const forbidden = /forbidden/i.test((error as Error).message);
    return (
      <div>
        <PageHeader eyebrow="Operator · Restricted" title="Action type diagnostics" />
        <div className="p-5 md:p-8">
          <div className="panel border-orange/40 bg-orange/5 p-6">
            <div className="label-eyebrow text-orange">{forbidden ? "Access denied" : "Error"}</div>
            <p className="mt-2 text-sm text-muted-foreground">
              {forbidden ? "This page is restricted to Temaro operators." : (error as Error).message}
            </p>
          </div>
        </div>
      </div>
    );
  }

  const constraintSql = data?.constraintDef
    ? `ALTER TABLE public.logs ADD CONSTRAINT ${data.constraintName}\n  ${data.constraintDef};`
    : "";

  return (
    <div>
      <PageHeader
        eyebrow="Operator · Diagnostics"
        title="Action type diagnostics"
        actions={
          <div className="flex flex-wrap items-center gap-2">
          {data && (
            <>
              <button
                type="button"
                onClick={() => {
                  downloadTextFile(
                    actionTypesFilename("json"),
                    "application/json",
                    buildActionTypesJson(data),
                  );
                  toast.success("Exported action types (JSON)");
                }}
                className="kb-focus flex items-center gap-1.5 rounded-sm border border-border bg-card px-3 py-2 text-xs uppercase tracking-wider hover:bg-accent"
              >
                <Download size={12} />
                Export JSON
              </button>
              <button
                type="button"
                onClick={() => {
                  downloadTextFile(
                    actionTypesFilename("sql"),
                    "application/sql",
                    buildActionTypesSql(data),
                  );
                  toast.success("Exported action types (SQL)");
                }}
                className="kb-focus flex items-center gap-1.5 rounded-sm border border-border bg-card px-3 py-2 text-xs uppercase tracking-wider hover:bg-accent"
              >
                <Download size={12} />
                Export SQL
              </button>
            </>
          )}
          <button
            type="button"
            onClick={() => check.mutate()}
            disabled={check.isPending}
            className="kb-focus flex items-center gap-1.5 rounded-sm border border-border bg-card px-3 py-2 text-xs uppercase tracking-wider hover:bg-accent disabled:opacity-60"
          >
            <RefreshCw size={12} className={check.isPending ? "motion-safe:animate-spin" : ""} />
            {check.isPending ? "Checking…" : "Run drift check"}
          </button>
          </div>
        }
      />

      <div className="space-y-4 p-5 md:p-8">
        {isLoading && (
          <p className="mono text-xs uppercase tracking-widest text-muted-foreground">Loading diagnostics…</p>
        )}

        {data && (
          <>
            {/* Live status */}
            <div
              className={`panel p-5 ${data.matched ? "border-moss/40 bg-moss/5" : "border-orange/50 bg-orange/5"}`}
            >
              <div className="flex items-center gap-2">
                {data.matched ? <Check size={16} className="text-moss" /> : <ShieldAlert size={16} className="text-orange" />}
                <div className="label-eyebrow">{data.matched ? "In sync" : "Drift detected"}</div>
              </div>
              <p className="mt-2 text-sm text-muted-foreground">
                {data.matched
                  ? `The generated enum matches all ${data.dbValues.length} values in the database constraint, in order.`
                  : "The generated enum no longer matches the database constraint. Re-run the generator and review the diff."}
              </p>
              {!data.matched && (
                <ul className="mono mt-3 space-y-1 text-[11px] uppercase tracking-widest text-orange">
                  {data.missingInDb.length > 0 && <li>In code, not in database: {data.missingInDb.join(", ")}</li>}
                  {data.missingInGenerated.length > 0 && (
                    <li>In database, not in code: {data.missingInGenerated.join(", ")}</li>
                  )}
                  {data.orderDiffers && <li>Same values, different order</li>}
                </ul>
              )}
            </div>

            {/* Last drift results */}
            <div className="grid gap-4 md:grid-cols-2">
              <RunCard title="Last successful drift test" run={data.lastSuccessfulRun} tone="ok" />
              <RunCard title="Most recent drift test" run={data.lastRun} tone={data.lastRun?.matched ? "ok" : "warn"} />
            </div>

            {/* Full drift history */}
            <DriftHistoryPanel runs={data.history} />

            <ActionTypeCoveragePanel />

            {/* Generated enum values */}
            <div className="panel p-5">
              <div className="flex items-center gap-2">
                <ScrollText size={16} className="text-steel" />
                <div className="label-eyebrow">Generated enum · {data.generatedValues.length} values</div>
              </div>
              <p className="mono mt-1 text-[10px] uppercase tracking-widest text-muted-foreground">
                src/lib/log-action-types.generated.ts — auto-generated from the database constraint
              </p>
              <div className="mt-4 overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-border bg-background">
                      <Th>action_type</Th>
                      <Th>Log label</Th>
                      <Th>Meaning</Th>
                      <Th>In database</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.generatedValues.map((v) => {
                      const p = LOG_ACTION_PRESENTATION[v as keyof typeof LOG_ACTION_PRESENTATION];
                      const inDb = data.dbValues.includes(v);
                      return (
                        <tr key={v} className="border-b border-border/50 last:border-0">
                          <Td>
                            <span className="mono text-xs">{v}</span>
                          </Td>
                          <Td>
                            <span className="inline-flex items-center gap-2">
                              <span className={`h-2 w-2 rounded-full ${p?.dot ?? "bg-muted-foreground"}`} />
                              <span className="mono text-[11px] uppercase tracking-widest">{p?.label ?? "—"}</span>
                              {p?.isNew && (
                                <span className="mono rounded-sm bg-primary/15 px-1.5 py-0.5 text-[9px] uppercase tracking-widest text-primary">
                                  New
                                </span>
                              )}
                            </span>
                          </Td>
                          <Td>
                            <span className="text-xs text-muted-foreground">{p?.description ?? "—"}</span>
                          </Td>
                          <Td>
                            {inDb ? (
                              <span className="mono text-[10px] uppercase tracking-widest text-moss">Yes</span>
                            ) : (
                              <span className="mono text-[10px] uppercase tracking-widest text-orange">Missing</span>
                            )}
                          </Td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Constraint */}
            <div className="panel p-5">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <Database size={16} className="text-steel" />
                  <div className="label-eyebrow">Database constraint</div>
                </div>
                <button
                  type="button"
                  disabled={!constraintSql}
                  onClick={async () => {
                    await navigator.clipboard.writeText(constraintSql);
                    setCopied(true);
                    toast.success("Constraint SQL copied");
                    window.setTimeout(() => setCopied(false), 2000);
                  }}
                  className="kb-focus flex items-center gap-1.5 rounded-sm border border-border bg-card px-3 py-1.5 text-[10px] uppercase tracking-widest hover:bg-accent disabled:opacity-50"
                >
                  {copied ? <Check size={11} /> : <Copy size={11} />} Copy SQL
                </button>
              </div>
              <p className="mono mt-2 text-[11px] uppercase tracking-widest text-muted-foreground">
                public.logs · {data.constraintName}
              </p>
              <pre className="mono mt-3 overflow-x-auto whitespace-pre-wrap rounded-sm border border-border bg-background p-3 text-[11px] leading-relaxed">
                {data.constraintDef ?? "Constraint not found — run the migration."}
              </pre>
              <p className="mt-3 text-xs text-muted-foreground">
                Changes must start as a database migration, then run{" "}
                <span className="mono">node scripts/generate-log-action-types.mjs</span> to mirror the new whitelist
                into the app enum.
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function RunCard({
  title,
  run,
  tone,
}: {
  title: string;
  run: LogActionDiagnostics["lastRun"];
  tone: "ok" | "warn";
}) {
  return (
    <div className="panel p-5">
      <div className="label-eyebrow">{title}</div>
      {run ? (
        <>
          <div className="font-display mt-2 text-xl uppercase">{fmtWhen(run.ranAt)}</div>
          <div
            className={`mono mt-1 text-[10px] uppercase tracking-widest ${
              tone === "ok" && run.matched ? "text-moss" : "text-orange"
            }`}
          >
            {run.matched ? "Passed" : "Failed"} · {run.dbValues.length} database values
          </div>
          {run.detail && <p className="mt-2 text-xs text-muted-foreground">{run.detail}</p>}
        </>
      ) : (
        <p className="mt-2 text-sm text-muted-foreground">No drift check recorded yet — run one above.</p>
      )}
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="mono px-3 py-2 text-[10px] font-normal uppercase tracking-widest text-muted-foreground">
      {children}
    </th>
  );
}

function Td({ children }: { children: React.ReactNode }) {
  return <td className="px-3 py-2 align-top">{children}</td>;
}
