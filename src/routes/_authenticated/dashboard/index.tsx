import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader } from "@/components/AppShell";
import { CalendarDays, Check, ChevronDown, ChevronRight, Clock, ExternalLink, MapPin, Undo2 } from "lucide-react";
import { DispatchLog } from "@/components/DispatchLog";
import { LastRefreshedStatus } from "@/components/LastRefreshedStatus";
import { HomeGreetingWeather } from "@/components/HomeGreetingWeather";
import { toast } from "sonner";
import { HOME_QUOTE_AUTOHIDE_DAYS, isOlderThanDays } from "@/lib/relative-time";
import { AttentionTimestamp } from "@/components/AttentionTimestamp";

import { useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { provisionTenantNumber } from "@/lib/twilio-provision.functions";


export const Route = createFileRoute("/_authenticated/dashboard/")({
  // ?logTypes=a,b, ?logSort=oldest, ?q=, and ?dateFrom=/?dateTo= keep the
  // Activity log's filters, search, and date range across reloads and shared links.
  validateSearch: (
    search: Record<string, unknown>,
  ): { logTypes?: string; logSort?: string; q?: string; dateFrom?: string; dateTo?: string } => ({
    ...(typeof search["logTypes"] === "string" ? { logTypes: search["logTypes"] as string } : {}),
    ...(search["logSort"] === "oldest" ? { logSort: "oldest" as const } : {}),
    ...(typeof search["q"] === "string" && search["q"] !== "" ? { q: search["q"] as string } : {}),
    ...(typeof search["dateFrom"] === "string" ? { dateFrom: search["dateFrom"] as string } : {}),
    ...(typeof search["dateTo"] === "string" ? { dateTo: search["dateTo"] as string } : {}),
  }),


  component: HomePage,
});

const AWAY_KEY = "temaro.lastHomeVisit";

function money(n: number) {
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function fmtTime(t: string | null) {
  if (!t) return "All day";
  const [h, m] = t.split(":");
  const d = new Date();
  d.setHours(Number(h), Number(m), 0, 0);
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function HomePage() {
  const qc = useQueryClient();
  const backfilled = useRef(false);
  const provisionFn = useServerFn(provisionTenantNumber);
  // Deep-linked/persisted record-type filters imply the user was looking at the log.
  const { logTypes } = Route.useSearch();
  const [logOpen, setLogOpen] = useState(Boolean(logTypes));
  const [awaySince] = useState(() => {
    if (typeof window === "undefined") return new Date(Date.now() - 86400000).toISOString();
    const prev = window.localStorage.getItem(AWAY_KEY);
    window.localStorage.setItem(AWAY_KEY, new Date().toISOString());
    return prev ?? new Date(Date.now() - 86400000).toISOString();
  });

  // Silent safety-net: if a tenant reached the dashboard without a number
  // (skipped onboarding, older account), buy one in the background.
  useEffect(() => {
    if (backfilled.current) return;
    backfilled.current = true;
    (async () => {
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) return;
      const { data: prof } = await supabase
        .from("profiles").select("twilio_phone_number").eq("id", u.user.id).maybeSingle();
      if (prof?.twilio_phone_number) return;
      try {
        await provisionFn({ data: {} });
      } catch {
        /* onboarding page surfaces the error; keep the dashboard quiet */
      }
    })();
  }, [provisionFn]);

  void qc;

  const { data: homeProfile } = useQuery({
    queryKey: ["home", "profile-basics"],
    queryFn: async () => {
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) return null;
      const { data } = await supabase
        .from("profiles")
        .select("business_name, zip_code")
        .eq("id", u.user.id)
        .maybeSingle();
      return data;
    },
    staleTime: 5 * 60_000,
  });

  const { data: today, isLoading: loadingToday } = useQuery({
    queryKey: ["home", "today-appointments"],
    queryFn: async () => {
      const { data } = await supabase
        .from("appointments")
        .select("id, title, time, notes, customer_id, customers(first_name, last_name, phone_number)")
        .eq("date", todayISO())
        .order("time", { ascending: true });
      return data ?? [];
    },
  });

  const { data: attention, isLoading: loadingAttention } = useQuery({
    queryKey: ["home", "attention"],
    queryFn: async () => {
      const [sent, intakes, declined, accepted, dismissals] = await Promise.all([
        supabase
          .from("quotes")
          .select("id, user_id, customer_first_name, customer_last_name, total_amount, status, decline_reason, last_sms_sent_at, created_at")
          .eq("status", "sent")
          .is("archived_at", null)
          .order("created_at", { ascending: false })
          .limit(25),
        supabase
          .from("intake_submissions")
          .select("id, customer_first_name, customer_last_name, submitted_at")
          .eq("status", "new")
          .order("submitted_at", { ascending: false })
          .limit(25),
        supabase
          .from("quotes")
          .select("id, user_id, customer_first_name, customer_last_name, status, decline_reason, responded_at, created_at")
          .eq("status", "declined")
          .is("decline_followup_sent_at", null)
          .order("responded_at", { ascending: false })
          .limit(25),
        supabase
          .from("quotes")
          .select("id, user_id, customer_first_name, customer_last_name, total_amount, status, decline_reason, responded_at, created_at")
          .eq("status", "accepted")
          .is("archived_at", null)
          .order("responded_at", { ascending: false })
          .limit(25),
        supabase
          .from("home_quote_dismissals")
          .select("quote_id, dismissed_status, dismissed_decline_reason"),
      ]);

      const hidden = new Map(
        (dismissals.data ?? []).map((d) => [
          d.quote_id,
          { status: d.dismissed_status, reason: d.dismissed_decline_reason ?? null },
        ]),
      );

      // A dismissal (manual or age-based) only holds while the quote sits in the
      // exact status + decline reason it was hidden in. Real customer action
      // (sent → accepted/declined, or a decline reason captured later) resurfaces it.
      const visible = <
        T extends { id: string; status: string; decline_reason?: string | null; created_at?: string | null },
      >(
        rows: T[] | null,
        stamp: (r: T) => string | null,
      ) =>
        (rows ?? []).filter((r) => {
          const h = hidden.get(r.id);
          if (h && h.status === r.status && h.reason === (r.decline_reason ?? null)) return false;
          return !isOlderThanDays(stamp(r) ?? r.created_at ?? null, HOME_QUOTE_AUTOHIDE_DAYS);
        });

      return {
        sent: visible(sent.data, (r) => r.last_sms_sent_at ?? r.created_at),
        // New, uncontacted requests never auto-hide — an untouched lead keeps showing.
        intakes: intakes.data ?? [],
        declined: visible(declined.data, (r) => r.responded_at ?? r.created_at),
        accepted: visible(accepted.data, (r) => r.responded_at ?? r.created_at),
      };
    },
  });

  // Last dismissal from this session, so an accidental "Mark complete" can be
  // reversed from the panel header even after the toast disappears.
  const [lastDismissed, setLastDismissed] = useState<
    | { kind: "intake"; id: string; label: string }
    | { kind: "quote"; id: string; label: string }
    | null
  >(null);

  const undoIntake = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("intake_submissions").update({ status: "new" }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: (_d, id) => {
      toast.success("Brought back — this request is waiting on you again");
      setLastDismissed((prev) => (prev?.kind === "intake" && prev.id === id ? null : prev));
      qc.invalidateQueries({ queryKey: ["home", "attention"] });
      qc.invalidateQueries({ queryKey: ["intakes"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const undoHideQuote = useMutation({
    mutationFn: async (quoteId: string) => {
      const { error } = await supabase.from("home_quote_dismissals").delete().eq("quote_id", quoteId);
      if (error) throw error;
    },
    onSuccess: (_d, quoteId) => {
      toast.success("Brought back to Home");
      setLastDismissed((prev) => (prev?.kind === "quote" && prev.id === quoteId ? null : prev));
      qc.invalidateQueries({ queryKey: ["home", "attention"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const markIntakeContacted = useMutation({
    mutationFn: async (item: { id: string; label: string }) => {
      const { error } = await supabase.from("intake_submissions").update({ status: "contacted" }).eq("id", item.id);
      if (error) throw error;
      return item;
    },
    onSuccess: (item) => {
      setLastDismissed({ kind: "intake", id: item.id, label: item.label });
      toast.success("Marked contacted", {
        action: { label: "Undo", onClick: () => undoIntake.mutate(item.id) },
        duration: 10000,
      });
      qc.invalidateQueries({ queryKey: ["home", "attention"] });
      qc.invalidateQueries({ queryKey: ["intakes"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const hideQuote = useMutation({
    mutationFn: async (q: {
      id: string;
      user_id: string;
      status: string;
      decline_reason?: string | null;
      label: string;
    }) => {
      const { data: u } = await supabase.auth.getUser();
      const { error } = await supabase.from("home_quote_dismissals").upsert(
        {
          quote_id: q.id,
          business_owner_id: q.user_id,
          dismissed_status: q.status,
          dismissed_decline_reason: q.decline_reason ?? null,
          dismissed_by: u.user?.id ?? null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "quote_id" },
      );
      if (error) throw error;
      return q;
    },
    onSuccess: (q) => {
      setLastDismissed({ kind: "quote", id: q.id, label: q.label });
      toast.success("Hidden from Home — the quote itself is untouched and still live", {
        action: { label: "Undo", onClick: () => undoHideQuote.mutate(q.id) },
        duration: 10000,
      });
      qc.invalidateQueries({ queryKey: ["home", "attention"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const undoing = undoIntake.isPending || undoHideQuote.isPending;

  function undoLast() {
    if (!lastDismissed) return;
    if (lastDismissed.kind === "intake") undoIntake.mutate(lastDismissed.id);
    else undoHideQuote.mutate(lastDismissed.id);
  }



  const { data: money7 } = useQuery({
    queryKey: ["home", "money", awaySince],
    queryFn: async () => {
      const since = new Date(Date.now() - 7 * 86400000).toISOString();
      const [paid, open] = await Promise.all([
        supabase
          .from("quotes")
          .select("id, deposit_amount, deposit_paid_at, customer_first_name")
          .eq("deposit_paid", true)
          .gte("deposit_paid_at", since),
        supabase
          .from("quotes")
          .select("id, total_amount, deposit_amount, deposit_paid")
          .in("status", ["sent", "accepted"])
          .is("archived_at", null),
      ]);
      const depositsPaid = (paid.data ?? []).reduce((s, r) => s + Number(r.deposit_amount ?? 0), 0);
      const owed = (open.data ?? []).reduce(
        (s, r) => s + Math.max(0, Number(r.total_amount ?? 0) - (r.deposit_paid ? Number(r.deposit_amount ?? 0) : 0)),
        0,
      );
      return { depositsPaid, depositsCount: (paid.data ?? []).length, owed, openCount: (open.data ?? []).length };
    },
  });

  const { data: away } = useQuery({
    queryKey: ["home", "away", awaySince],
    queryFn: async () => {
      const { data } = await supabase
        .from("logs")
        .select("action_type")
        .gte("created_at", awaySince);
      const rows = data ?? [];
      return {
        calls: rows.filter((r) => r.action_type === "missed_call_text").length,
        reviews: rows.filter((r) => r.action_type === "review_request").length,
        reactivations: rows.filter((r) => r.action_type === "reactivation_text").length,
      };
    },
  });

  const awayLine = (() => {
    if (!away) return "Checking what happened while you were away…";
    const parts: string[] = [];
    if (away.calls) parts.push(`answered ${away.calls} missed call${away.calls === 1 ? "" : "s"}`);
    if (away.reviews) parts.push(`sent ${away.reviews} review request${away.reviews === 1 ? "" : "s"}`);
    if (away.reactivations) parts.push(`sent ${away.reactivations} win-back text${away.reactivations === 1 ? "" : "s"}`);
    if (parts.length === 0) return "Nothing needed answering while you were away — your line stayed quiet.";
    const joined = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
    return `Temaro ${joined} while you were away.`;
  })();

  const attentionCount =
    (attention?.sent.length ?? 0) +
    (attention?.intakes.length ?? 0) +
    (attention?.declined.length ?? 0) +
    (attention?.accepted.length ?? 0);


  return (
    <div>
      <PageHeader eyebrow="Today" title="Home" />

      <div className="space-y-4 p-5 md:p-8">
        <HomeGreetingWeather
          businessName={homeProfile?.business_name}
          zipCode={homeProfile?.zip_code}
        />

        {/* Today's Schedule */}
        <section className="panel">
          <div className="flex items-center justify-between border-b border-border px-5 py-3">
            <div className="label-eyebrow">Today’s Schedule</div>
            <Link to="/dashboard/schedule" className="mono text-[10px] uppercase tracking-widest text-moss hover:text-foreground">
              Schedule <ChevronRight size={12} className="inline" />
            </Link>
          </div>
          {loadingToday ? (
            <div className="p-5 text-sm text-muted-foreground">Loading…</div>
          ) : (today?.length ?? 0) === 0 ? (
            <div className="flex items-center gap-2 p-5 text-sm text-muted-foreground">
              <CalendarDays size={16} /> Nothing on the books today.
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {today!.map((a) => {
                const c = (a as { customers?: { first_name: string; last_name: string | null } | null }).customers;
                const who = c ? `${c.first_name}${c.last_name ? ` ${c.last_name}` : ""}` : a.title;
                return (
                  <li key={a.id} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-5 py-3">
                    <span className="mono text-sm text-foreground">
                      <Clock size={12} className="mr-1.5 inline" />
                      {fmtTime(a.time)}
                    </span>
                    <span className="text-sm font-medium text-foreground">{who}</span>
                    <span className="text-sm text-muted-foreground">{a.title}</span>
                    {a.notes ? (
                      <span className="flex items-center gap-1 text-xs text-muted-foreground">
                        <MapPin size={12} /> {a.notes}
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* Needs your attention */}
        <section className="panel">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3">
            <div className="label-eyebrow">Needs your attention</div>
            <div className="flex items-center gap-3">
              {lastDismissed ? (
                <button
                  type="button"
                  onClick={undoLast}
                  disabled={undoing}
                  title={`Bring ${lastDismissed.label || "the last item"} back to this list`}
                  className="mono kb-focus flex items-center gap-1 border border-border px-2 py-1 text-[10px] uppercase tracking-widest text-steel hover:bg-accent hover:text-foreground disabled:opacity-50"
                >
                  <Undo2 size={12} /> {undoing ? "Undoing…" : `Undo ${lastDismissed.label || "last"}`}
                </button>
              ) : null}
              <span className="mono text-[10px] uppercase tracking-widest text-muted-foreground">{attentionCount}</span>
            </div>
          </div>
          <div aria-live="polite" className="sr-only">
            {undoing ? "Bringing the item back" : ""}
          </div>

          {loadingAttention ? (
            <div className="p-5 text-sm text-muted-foreground">Loading…</div>
          ) : attentionCount === 0 ? (
            <div className="p-5 text-sm text-muted-foreground">Nothing waiting on you right now.</div>
          ) : (
            <ul className="divide-y divide-border">
              {attention!.intakes.map((i) => (
                <li key={`i-${i.id}`} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-sm">
                  <Link
                    to="/dashboard/intakes"
                    search={{ intakeId: i.id }}
                    hash={`intake-${i.id}`}
                    title="Open this request in Intakes"
                    className="mono kb-focus flex flex-1 flex-wrap items-baseline gap-2 hover:underline"
                  >
                    <span className="mono text-[10px] uppercase tracking-widest text-orange">New request</span>
                    <span className="font-medium text-foreground">
                      {i.customer_first_name} {i.customer_last_name}
                    </span>
                    <span className="text-muted-foreground">wants a quote</span>
                    <AttentionTimestamp iso={i.submitted_at} label="Submitted" />
                    <span className="mono flex items-center gap-1 text-[10px] uppercase tracking-widest text-steel">
                      <ChevronRight size={12} /> open request
                    </span>
                  </Link>
                  <button
                    type="button"
                    onClick={() =>
                      markIntakeContacted.mutate({
                        id: i.id,
                        label: `${i.customer_first_name} ${i.customer_last_name ?? ""}`.trim(),
                      })
                    }
                    disabled={markIntakeContacted.isPending}
                    title="Sets this request's status to Contacted"
                    className="mono kb-focus flex items-center gap-1 border border-border px-2 py-1 text-[10px] uppercase tracking-widest text-moss hover:bg-accent hover:text-foreground disabled:opacity-50"
                  >
                    <Check size={12} /> Mark complete
                  </button>
                </li>
              ))}
              {attention!.sent.map((q) => (
                <li key={`s-${q.id}`} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-sm">
                  <Link
                    to="/quote/$quoteId"
                    params={{ quoteId: q.id }}
                    target="_blank"
                    rel="noreferrer"
                    title="Open the customer's quote page in a new tab"
                    className="mono kb-focus flex flex-1 flex-wrap items-baseline gap-2 hover:underline"
                  >
                    <span className="mono text-[10px] uppercase tracking-widest text-steel">Waiting on customer</span>
                    <span className="font-medium text-foreground">
                      {q.customer_first_name} {q.customer_last_name ?? ""}
                    </span>
                    <span className="text-muted-foreground">quote for {money(Number(q.total_amount ?? 0))}</span>
                    <AttentionTimestamp iso={q.last_sms_sent_at ?? q.created_at} label="Sent" />
                    <span className="mono flex items-center gap-1 text-[10px] uppercase tracking-widest text-steel">
                      <ExternalLink size={11} /> open quote
                    </span>
                  </Link>
                  <button
                    type="button"
                    onClick={() =>
                      hideQuote.mutate({
                        ...q,
                        label: `${q.customer_first_name} ${q.customer_last_name ?? ""}`.trim(),
                      })
                    }
                    disabled={hideQuote.isPending}
                    title="Hides this quote from Home only — the quote stays live for the customer"
                    className="mono kb-focus flex items-center gap-1 border border-border px-2 py-1 text-[10px] uppercase tracking-widest text-moss hover:bg-accent hover:text-foreground disabled:opacity-50"
                  >
                    <Check size={12} /> Mark complete
                  </button>
                </li>
              ))}
              {attention!.accepted.map((q) => (
                <li key={`a-${q.id}`} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-sm">
                  <Link
                    to="/quote/$quoteId"
                    params={{ quoteId: q.id }}
                    target="_blank"
                    rel="noreferrer"
                    title="Open the customer's quote page in a new tab"
                    className="mono kb-focus flex flex-1 flex-wrap items-baseline gap-2 hover:underline"
                  >
                    <span className="mono text-[10px] uppercase tracking-widest text-orange">Accepted · book it</span>
                    <span className="font-medium text-foreground">
                      {q.customer_first_name} {q.customer_last_name ?? ""}
                    </span>
                    <span className="text-muted-foreground">quote for {money(Number(q.total_amount ?? 0))}</span>
                    <AttentionTimestamp iso={q.responded_at ?? q.created_at} label="Responded" />
                    <span className="mono flex items-center gap-1 text-[10px] uppercase tracking-widest text-steel">
                      <ExternalLink size={11} /> open quote
                    </span>
                  </Link>
                  <button
                    type="button"
                    onClick={() =>
                      hideQuote.mutate({
                        ...q,
                        label: `${q.customer_first_name} ${q.customer_last_name ?? ""}`.trim(),
                      })
                    }
                    disabled={hideQuote.isPending}
                    title="Hides this quote from Home only — the quote stays live for the customer"
                    className="mono kb-focus flex items-center gap-1 border border-border px-2 py-1 text-[10px] uppercase tracking-widest text-moss hover:bg-accent hover:text-foreground disabled:opacity-50"
                  >
                    <Check size={12} /> Mark complete
                  </button>
                </li>
              ))}
              {attention!.declined.map((q) => (
                <li key={`d-${q.id}`} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-sm">
                  <Link
                    to="/quote/$quoteId"
                    params={{ quoteId: q.id }}
                    target="_blank"
                    rel="noreferrer"
                    title="Open the customer's quote page in a new tab"
                    className="mono kb-focus flex flex-1 flex-wrap items-baseline gap-2 hover:underline"
                  >
                    <span className="mono text-[10px] uppercase tracking-widest text-moss">Declined · review</span>
                    <span className="font-medium text-foreground">
                      {q.customer_first_name} {q.customer_last_name ?? ""}
                    </span>
                    <span className="text-muted-foreground">
                      {q.decline_reason ? `“${q.decline_reason}”` : "no reason given"}
                    </span>
                    <AttentionTimestamp iso={q.responded_at ?? q.created_at} label="Responded" />
                    <span className="mono flex items-center gap-1 text-[10px] uppercase tracking-widest text-steel">
                      <ExternalLink size={11} /> open quote
                    </span>
                  </Link>
                  <button
                    type="button"
                    onClick={() =>
                      hideQuote.mutate({
                        ...q,
                        label: `${q.customer_first_name} ${q.customer_last_name ?? ""}`.trim(),
                      })
                    }
                    disabled={hideQuote.isPending}
                    title="Hides this quote from Home only — the quote stays live for the customer"
                    className="mono kb-focus flex items-center gap-1 border border-border px-2 py-1 text-[10px] uppercase tracking-widest text-moss hover:bg-accent hover:text-foreground disabled:opacity-50"
                  >
                    <Check size={12} /> Mark complete
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>


        {/* Money */}
        <section className="panel">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-5 py-3">
            <div className="label-eyebrow">Money</div>
            <LastRefreshedStatus />
          </div>

          <div className="grid gap-px bg-border sm:grid-cols-2">
            <div className="bg-card p-5">
              <div className="mono text-[10px] uppercase tracking-widest text-muted-foreground">Deposits paid · last 7 days</div>
              <div className="stat-num mt-2 text-foreground">{money(money7?.depositsPaid ?? 0)}</div>
              <div className="mono mt-1 text-[10px] uppercase tracking-widest text-moss">
                {money7?.depositsCount ?? 0} deposit{(money7?.depositsCount ?? 0) === 1 ? "" : "s"}
              </div>
            </div>
            <div className="bg-card p-5">
              <div className="mono text-[10px] uppercase tracking-widest text-muted-foreground">Still owed · open quotes</div>
              <div className="stat-num mt-2 text-foreground">{money(money7?.owed ?? 0)}</div>
              <div className="mono mt-1 text-[10px] uppercase tracking-widest text-moss">
                across {money7?.openCount ?? 0} open quote{(money7?.openCount ?? 0) === 1 ? "" : "s"}
              </div>
            </div>
          </div>
        </section>

        {/* While you were away */}
        <section className="panel p-5">
          <div className="label-eyebrow">While you were away</div>
          <p className="mt-2 text-base text-foreground">{awayLine}</p>
        </section>

        {/* Activity log — secondary, collapsed by default */}
        <section>
          <button
            type="button"
            onClick={() => setLogOpen((v) => !v)}
            aria-expanded={logOpen}
            className="panel flex w-full items-center justify-between px-5 py-3 text-left hover:bg-accent"
          >
            <span className="label-eyebrow">Activity log</span>
            <ChevronDown size={16} className={`text-muted-foreground transition-transform ${logOpen ? "rotate-180" : ""}`} />
          </button>
          {logOpen ? (
            <div className="mt-3">
              <DispatchLog />
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}
