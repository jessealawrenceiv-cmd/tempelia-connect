import { createFileRoute, Link, useLocation } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader } from "@/components/AppShell";
import { signIntakePhotos } from "@/lib/intake.functions";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  intakeDeepLinkHref,
  parseIntakeDeepLink,
  resolveIntakeJump,
  type IntakeJumpMissReason,
} from "@/lib/intake-deep-link";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/dashboard/intakes")({
  validateSearch: (search: Record<string, unknown>) => ({
    intakeId: typeof search.intakeId === "string" ? search.intakeId : undefined,
  }),
  component: IntakesPage,
});

const STATUSES = ["new", "contacted", "quoted", "closed"] as const;

function IntakesPage() {
  const qc = useQueryClient();
  const sign = useServerFn(signIntakePhotos);
  const [publicUrl, setPublicUrl] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    if (!copiedId) return;
    const t = window.setTimeout(() => setCopiedId(null), 2000);
    return () => window.clearTimeout(t);
  }, [copiedId]);

  const { data: user } = useQuery({
    queryKey: ["me-id"],
    queryFn: async () => (await supabase.auth.getUser()).data.user,
  });

  useEffect(() => {
    if (user) setPublicUrl(`${window.location.origin}/intake/${user.id}`);
  }, [user]);

  const { data: rows, isLoading } = useQuery({
    queryKey: ["intake-submissions"],
    refetchOnWindowFocus: true,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("intake_submissions")
        .select("*")
        .order("submitted_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });

  // Live updates: push new/changed intake rows into the list without a reload.
  useEffect(() => {
    if (!user) return;
    const channel = supabase
      .channel("intake_submissions:dashboard")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "intake_submissions", filter: `user_id=eq.${user.id}` },
        () => qc.invalidateQueries({ queryKey: ["intake-submissions"] }),
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [user, qc]);

  const allPaths = useMemo(
    () => (rows ?? []).flatMap((r) => r.photo_urls ?? []),
    [rows],
  );

  const { data: signed } = useQuery({
    queryKey: ["intake-photo-urls", allPaths],
    enabled: allPaths.length > 0,
    queryFn: async () => (await sign({ data: { paths: allPaths } })).urls,
  });

  const updateStatus = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: string }) => {
      const { error } = await supabase.from("intake_submissions").update({ status }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Status updated");
      qc.invalidateQueries({ queryKey: ["intake-submissions"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // ── Deep link: jump to a specific submission (?intakeId= / #intake-<id>) ──
  // Works with browser back/forward: every history entry gets its own key, so
  // popping back to an earlier entry re-evaluates (and re-highlights) it, and
  // landing on an entry without an intake id clears the highlight.
  const location = useLocation();
  const { intakeId: incomingIntakeId } = parseIntakeDeepLink(location.searchStr, location.hash);
  const historyKey =
    (location.state as { key?: string } | undefined)?.key ??
    `${location.searchStr ?? ""}|${location.hash ?? ""}`;
  const rowRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [jumpedId, setJumpedId] = useState<string | null>(null);
  const [jumpMiss, setJumpMiss] = useState<{ id: string; reason: IntakeJumpMissReason } | null>(null);
  const jumpMissHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const handledJumpRef = useRef<string | null>(null);

  useEffect(() => {
    if (isLoading || !rows) return;

    // A history entry with no intake id means "no target": clear any highlight.
    if (!incomingIntakeId) {
      handledJumpRef.current = null;
      setJumpedId(null);
      setJumpMiss(null);
      return;
    }

    const dedupeKey = `${historyKey}::${incomingIntakeId}`;
    if (handledJumpRef.current === dedupeKey) return;
    handledJumpRef.current = dedupeKey;

    const ids = rows.map((r) => r.id);
    const res = resolveIntakeJump(incomingIntakeId, ids, ids);
    if (res.kind === "hit") {
      setJumpMiss(null);
      setJumpedId(incomingIntakeId);
      requestAnimationFrame(() => {
        const el = rowRefs.current[incomingIntakeId];
        el?.scrollIntoView({ behavior: "smooth", block: "center" });
        el?.focus({ preventScroll: true });
      });
    } else {
      setJumpedId(null);
      setJumpMiss({ id: incomingIntakeId, reason: res.reason });
      const fallback = ids[res.fallbackIndex];
      if (fallback) {
        requestAnimationFrame(() => {
          rowRefs.current[fallback]?.scrollIntoView({ behavior: "smooth", block: "center" });
        });
      }
    }
  }, [incomingIntakeId, historyKey, isLoading, rows]);

  useEffect(() => {
    if (!jumpMiss) return;
    const t = window.setTimeout(() => jumpMissHeadingRef.current?.focus(), 60);
    return () => window.clearTimeout(t);
  }, [jumpMiss]);

  // Fade the highlight after a few seconds so the page settles.
  useEffect(() => {
    if (!jumpedId) return;
    const t = window.setTimeout(() => setJumpedId(null), 6000);
    return () => window.clearTimeout(t);
  }, [jumpedId]);

  return (
    <div>
      <PageHeader eyebrow="Feature 04" title="Project intakes" />
      <div className="p-5 md:p-8 space-y-5">
        <div className="panel p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="mono text-[10px] uppercase tracking-widest text-muted-foreground">// public intake URL</div>
            <IntakeEnabledToggle />
          </div>
          <div className="mt-2 flex items-center gap-2">
            <input readOnly value={publicUrl} className="flex-1 rounded-sm border border-border bg-background px-3 py-2 text-sm mono" />
            <button
              onClick={() => { navigator.clipboard.writeText(publicUrl); toast.success("Copied"); }}
              className="rounded-sm bg-violet px-3 py-2 text-xs font-display uppercase tracking-wider text-paper"
            >Copy</button>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">Share this link with prospects. Submissions land here.</p>
        </div>

        {jumpMiss && (
          <div
            role="alert"
            aria-live="assertive"
            aria-atomic="true"
            className="mono rounded-sm border border-orange/60 bg-orange/10 px-4 py-3 text-[11px] text-orange"
          >
            <div className="flex items-start gap-3">
              <div className="mt-0.5 text-lg leading-none" aria-hidden="true">🔎</div>
              <div className="flex-1">
                <h3
                  ref={jumpMissHeadingRef}
                  tabIndex={-1}
                  className="font-semibold uppercase tracking-widest text-[10px] outline-none focus-visible:ring-2 focus-visible:ring-orange/70"
                >
                  // we couldn't find that submission
                </h3>
                <p className="mt-1 normal-case text-muted-foreground">
                  {jumpMiss.reason === "empty"
                    ? "There are no intake submissions on this account yet, so there's nothing to jump to."
                    : jumpMiss.reason === "filtered"
                      ? "That submission exists but isn't in the current view. Reload the list to reveal it."
                      : "That submission is no longer in your intake list — it may have been deleted, or the link points at another account."}
                  {jumpMiss.reason !== "empty" && " We landed you on the newest submission instead."}
                </p>
                <div className="mt-2 flex items-center gap-2">
                  <span className="text-[10px] uppercase tracking-widest text-muted-foreground">requested id</span>
                  <code className="mono break-all rounded-sm border border-orange/40 bg-charcoal/40 px-1.5 py-0.5 text-[11px] text-paper">
                    {jumpMiss.id}
                  </code>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    onClick={() => { setJumpMiss(null); qc.invalidateQueries({ queryKey: ["intake-submissions"] }); handledJumpRef.current = null; }}
                    className="rounded-sm border border-orange/60 px-2 py-1 text-[10px] uppercase tracking-wider hover:bg-orange/20"
                  >
                    reload &amp; retry
                  </button>
                  <button
                    onClick={() => setJumpMiss(null)}
                    className="rounded-sm border border-border px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground hover:text-paper"
                  >
                    dismiss
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {isLoading && <div className="text-muted-foreground">Loading…</div>}
        {!isLoading && rows?.length === 0 && (
          <div className="panel p-6 text-muted-foreground text-sm">No submissions yet. Share your intake URL above.</div>
        )}

        <div className="space-y-4">
          {rows?.map((r) => {
            const resp = (r.responses ?? {}) as Record<string, string>;
            return (
              <div
                key={r.id}
                id={`intake-${r.id}`}
                ref={(el) => { rowRefs.current[r.id] = el; }}
                tabIndex={-1}
                data-jumped={jumpedId === r.id ? "true" : undefined}
                className={`panel p-5 outline-none transition-shadow ${
                  jumpedId === r.id ? "ring-2 ring-violet shadow-[0_0_0_4px_rgba(108,74,182,0.18)]" : ""
                }`}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="mono text-[10px] uppercase tracking-widest text-muted-foreground">
                      {new Date(r.submitted_at).toLocaleString()}
                    </div>
                    <h3 className="font-display text-xl uppercase mt-1">
                      {r.customer_first_name} {r.customer_last_name}
                    </h3>
                    <div className="mono text-xs text-muted-foreground mt-1">
                      {r.customer_phone}{r.customer_email && ` · ${r.customer_email}`}
                      {r.customer_business_name && ` · ${r.customer_business_name}`}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={async () => {
                        const url = `${window.location.origin}${intakeDeepLinkHref(r.id)}`;
                        try {
                          await navigator.clipboard.writeText(url);
                          setCopiedId(r.id);
                          toast.success("Link copied", { description: url });
                        } catch {
                          toast.error("Couldn't copy link");
                        }
                      }}
                      title="Copy the deep link to this submission"
                      className="mono rounded-sm border border-steel/60 px-2 py-1 text-[10px] uppercase tracking-wider text-steel hover:bg-steel hover:text-charcoal"
                    >
                      {copiedId === r.id ? "copied" : "copy link"}
                    </button>
                    <Link
                      to="/dashboard/schedule"
                      search={{
                        intakeId: r.id,
                        customerId: r.customer_id ?? undefined,
                        firstName: r.customer_first_name,
                        lastName: r.customer_last_name,
                        phone: r.customer_phone,
                        title: `Site visit — ${r.customer_first_name} ${r.customer_last_name}`.trim(),
                      }}
                      className="mono rounded-sm border border-moss/60 px-2 py-1 text-[10px] uppercase tracking-wider text-moss hover:bg-moss hover:text-charcoal"
                    >
                      schedule visit
                    </Link>
                    <select
                      value={r.status}
                      onChange={(e) => updateStatus.mutate({ id: r.id, status: e.target.value })}
                      className="rounded-sm border border-border bg-background px-2 py-1 text-xs uppercase tracking-wider mono"
                    >
                      {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </div>
                </div>

                <dl className="mt-4 grid gap-x-4 gap-y-2 text-sm md:grid-cols-2">
                  {Object.entries(resp).map(([k, v]) => (
                    <div key={k}>
                      <dt className="label-eyebrow text-[10px] uppercase tracking-wider text-muted-foreground">{k.replace(/_/g, " ")}</dt>
                      <dd className="mono text-xs whitespace-pre-wrap">{String(v) || "—"}</dd>
                    </div>
                  ))}
                </dl>

                {(r.photo_urls?.length ?? 0) > 0 && (
                  <div className="mt-4 flex flex-wrap gap-2">
                    {r.photo_urls.map((p: string) => (
                      <a key={p} href={signed?.[p]} target="_blank" rel="noreferrer" className="block">
                        {signed?.[p] ? (
                          <img src={signed[p]} alt="" className="h-24 w-24 rounded-sm border border-border object-cover" />
                        ) : (
                          <div className="h-24 w-24 rounded-sm border border-border bg-muted" />
                        )}
                      </a>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function IntakeEnabledToggle() {
  const qc = useQueryClient();
  const { data: enabled } = useQuery({
    queryKey: ["intake-enabled"],
    queryFn: async () => {
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) return true;
      const { data } = await supabase.from("profiles").select("intake_enabled").eq("id", u.user.id).maybeSingle();
      return data?.intake_enabled ?? true;
    },
  });
  const mut = useMutation({
    mutationFn: async (next: boolean) => {
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) throw new Error("Not signed in");
      const { error } = await supabase.from("profiles").update({ intake_enabled: next }).eq("id", u.user.id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Updated");
      qc.invalidateQueries({ queryKey: ["intake-enabled"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <label className="flex items-center gap-2 text-xs mono uppercase tracking-wider cursor-pointer">
      <span className={enabled ? "text-moss" : "text-muted-foreground"}>{enabled ? "accepting" : "paused"}</span>
      <input
        type="checkbox"
        checked={!!enabled}
        onChange={(e) => mut.mutate(e.target.checked)}
        className="h-4 w-4 accent-violet"
      />
    </label>
  );
}
