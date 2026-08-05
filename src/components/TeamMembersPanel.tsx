import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { InviteEmailPreviewDialog } from "@/components/InviteEmailPreviewDialog";
import {
  fetchTeamInviteEvents,
  logTeamInviteEvent,
  type TeamInviteEvent,
} from "@/lib/team-invite-audit";

type Member = {
  id: string;
  invited_email: string;
  role: string;
  invited_at: string;
  accepted_at: string | null;
  expires_at: string | null;
};

type Status = "pending" | "accepted" | "expired";

function statusOf(m: Member): Status {
  if (m.accepted_at) return "accepted";
  if (m.expires_at && new Date(m.expires_at).getTime() <= Date.now()) return "expired";
  return "pending";
}

const STATUS_STYLE: Record<Status, string> = {
  pending: "border-moss/50 text-moss",
  accepted: "border-violet/50 text-violet",
  expired: "border-destructive/50 text-destructive",
};

const fmtStamp = (iso: string) =>
  new Date(iso).toLocaleString([], {
    year: "2-digit",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

/** Dispatch-log color coding for audit rows. */
const EVENT_STYLE: Record<string, string> = {
  created: "text-moss",
  resent: "text-violet",
  accepted: "text-violet",
  revoked: "text-destructive",
  expired: "text-destructive",
};

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : "—");

/**
 * Team accounts panel (owner-only). Invites are Standard-tier only; the
 * database enforces the gate too, so Starter attempts fail server-side.
 * Claiming matches the signed-in user's confirmed email against a pending
 * invite — there is no secret token in a URL, so "sharing an invite" means
 * telling the person which email address to sign in with.
 */
export function TeamMembersPanel({ tier }: { tier: string | null | undefined }) {
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  /** null = closed; otherwise the invite being previewed (new invite has no id). */
  const [preview, setPreview] = useState<
    { email: string; expiresAt: string | null; isNew: boolean } | null
  >(null);
  const isStandard = tier === "standard";

  const { data: businessName } = useQuery({
    queryKey: ["profile_business_name"],
    queryFn: async () => {
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) return "";
      const { data } = await supabase
        .from("profiles")
        .select("business_name")
        .eq("id", u.user.id)
        .maybeSingle();
      return data?.business_name ?? "";
    },
  });

  /** Backend-authoritative seat allowance (plan tier + seats already in use). */
  const { data: seats } = useQuery({
    queryKey: ["team_seat_usage"],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("team_seat_usage");
      if (error) throw error;
      const row = (data ?? [])[0];
      return row
        ? {
            tier: row.tier as string,
            limit: row.seat_limit as number,
            used: row.seats_used as number,
            remaining: row.seats_remaining as number,
          }
        : null;
    },
  });

  const atCapacity = !!seats && seats.remaining <= 0;

  const { data: members } = useQuery({
    queryKey: ["team_members"],
    queryFn: async () => {
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) return [] as Member[];
      const { data, error } = await supabase
        .from("team_members")
        .select("id, invited_email, role, invited_at, accepted_at, expires_at")
        .eq("business_owner_id", u.user.id)
        .order("invited_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as Member[];
    },
  });

  const invite = useMutation({
    mutationFn: async () => {
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) throw new Error("Not signed in");
      const addr = email.trim().toLowerCase();
      if (!addr) throw new Error("Enter an email address.");
      const { data: row, error } = await supabase
        .from("team_members")
        .insert({ business_owner_id: u.user.id, invited_email: addr, role: "staff" })
        .select("id")
        .single();
      if (error) throw error;
      await logTeamInviteEvent({
        businessOwnerId: u.user.id,
        teamMemberId: row?.id ?? null,
        invitedEmail: addr,
        eventType: "created",
      });
    },
    onSuccess: () => {
      toast.success("Invite created. Tell them to sign in with that exact email address.");
      setEmail("");
      setPreview(null);
      qc.invalidateQueries({ queryKey: ["team_members"] });
      qc.invalidateQueries({ queryKey: ["team_invite_events"] });
      qc.invalidateQueries({ queryKey: ["team_seat_usage"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  /** Resend = push invited_at to now, which resets expires_at to a fresh 7 days. */
  const resend = useMutation({
    mutationFn: async (m: Member) => {
      const { error } = await supabase
        .from("team_members")
        .update({ invited_at: new Date().toISOString() })
        .eq("id", m.id);
      if (error) throw error;
      const { data: u } = await supabase.auth.getUser();
      if (u.user)
        await logTeamInviteEvent({
          businessOwnerId: u.user.id,
          teamMemberId: m.id,
          invitedEmail: m.invited_email,
          eventType: "resent",
        });
      return m;
    },
    onSuccess: (m) => {
      toast.success(`Invite for ${m.invited_email} extended 7 more days.`);
      qc.invalidateQueries({ queryKey: ["team_members"] });
      qc.invalidateQueries({ queryKey: ["team_invite_events"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const revoke = useMutation({
    mutationFn: async (m: Member) => {
      const { data: u } = await supabase.auth.getUser();
      if (u.user)
        await logTeamInviteEvent({
          businessOwnerId: u.user.id,
          teamMemberId: m.id,
          invitedEmail: m.invited_email,
          eventType: "revoked",
          detail: `${u.user.email ?? "owner"} · ${m.accepted_at ? "access removed" : "pending invite revoked"}`,
        });
      const { error } = await supabase.from("team_members").delete().eq("id", m.id);
      if (error) throw error;
      return m;
    },
    onSuccess: (m) => {
      toast.success(
        m.accepted_at
          ? `${m.invited_email} no longer has access.`
          : `Invite for ${m.invited_email} revoked.`,
      );
      qc.invalidateQueries({ queryKey: ["team_members"] });
      qc.invalidateQueries({ queryKey: ["team_invite_events"] });
      qc.invalidateQueries({ queryKey: ["team_seat_usage"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const copyInstructions = async (m: Member) => {
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    const text = `You've been invited to help run our Temaro account. Sign up or sign in at ${origin}/auth using this exact email address: ${m.invited_email}. Confirm the email from your inbox, then you'll be taken to ${origin}/accept-invite to activate access. The invite expires ${fmt(m.expires_at)}.`;
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Sign-in instructions copied.");
    } catch {
      toast.error("Could not copy — instructions: " + text);
    }
  };

  const rows = members ?? [];

  const [tab, setTab] = useState<Status | "all">("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);

  const counts = {
    all: rows.length,
    pending: rows.filter((m) => statusOf(m) === "pending").length,
    accepted: rows.filter((m) => statusOf(m) === "accepted").length,
    expired: rows.filter((m) => statusOf(m) === "expired").length,
  };

  const needle = search.trim().toLowerCase();
  const filtered = rows.filter(
    (m) =>
      (tab === "all" || statusOf(m) === tab) &&
      (!needle || m.invited_email.toLowerCase().includes(needle)),
  );

  const PAGE_SIZE = 8;
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const paged = filtered.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  const changeTab = (next: Status | "all") => {
    setTab(next);
    setPage(0);
  };

  const { data: auditRows } = useQuery({
    queryKey: ["team_invite_events"],
    queryFn: async () => {
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) return [] as TeamInviteEvent[];
      return await fetchTeamInviteEvents(u.user.id);
    },
    enabled: isStandard,
  });

  const { data: lastCleanup } = useQuery({
    queryKey: ["invite_cleanup_runs", "last"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("invite_cleanup_runs")
        .select("ran_at, deleted_count")
        .order("ran_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    enabled: isStandard,
  });

  /**
   * Expiry has no actor — nobody clicks it — so it is derived from the invite
   * row rather than written to the table, and merged into the same timeline.
   */
  const expiryEntries = rows
    .filter((m) => statusOf(m) === "expired" && m.expires_at)
    .map((m) => ({
      id: `exp-${m.id}`,
      invited_email: m.invited_email,
      event_type: "expired",
      detail: "system · 7-day window elapsed",
      occurred_at: m.expires_at as string,
    }));

  const timeline = [
    ...(auditRows ?? []).map((e) => ({
      id: e.id,
      invited_email: e.invited_email,
      event_type: e.event_type,
      detail: e.detail,
      occurred_at: e.occurred_at,
    })),
    ...expiryEntries,
  ].sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : -1));

  return (
    <div className="panel p-6">
      <div className="label-eyebrow">Team accounts</div>
      <h2 className="mt-1 text-xl">Staff logins</h2>

      {!isStandard ? (
        <div className="mt-3 rounded-sm border border-violet/40 bg-violet/10 p-4">
          <div className="mono text-[10px] uppercase tracking-widest text-violet">
            Upgrade required
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Starter is limited to a single login — <span className="mono">0</span> staff seats.
            Upgrade to <span className="uppercase">Standard</span> for{" "}
            <span className="mono">5</span> staff seats with their own credentials.
          </p>
          <p className="mono mt-2 text-[10px] uppercase tracking-widest text-violet">
            Seats: {seats?.used ?? 0}/{seats?.limit ?? 0} used · 0 remaining
          </p>
        </div>
      ) : (
        <>
          <div className="mono mt-3 flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-widest">
            <span className="text-muted-foreground">Staff seats</span>
            <span className={atCapacity ? "text-destructive" : "text-moss"}>
              {seats?.used ?? 0}/{seats?.limit ?? 0} used
            </span>
            <span className="text-muted-foreground">
              · {seats?.remaining ?? 0} remaining (pending invites count)
            </span>
          </div>

          {atCapacity && (
            <div className="mt-3 rounded-sm border border-violet/40 bg-violet/10 p-4">
              <div className="mono text-[10px] uppercase tracking-widest text-violet">
                Seat limit reached
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                All {seats?.limit ?? 0} staff seats on your plan are in use. Revoke a pending invite
                or remove a member to free a seat — or upgrade for more seats. The backend blocks
                invites past the limit, so this is enforced either way.
              </p>
              <a
                href="/dashboard/settings#billing"
                className="mono mt-3 inline-block rounded-sm bg-violet px-3 py-1.5 text-[10px] uppercase tracking-widest text-paper"
              >
                View plan options
              </a>
            </div>
          )}

          <div className="mt-4 flex flex-col gap-2 sm:flex-row">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="staff@example.com"
              className="w-full rounded-sm border border-border bg-background px-3 py-2 text-sm"
            />
            <button
              onClick={() => {
                const addr = email.trim().toLowerCase();
                if (!addr) {
                  toast.error("Enter an email address to preview.");
                  return;
                }
                setPreview({ email: addr, expiresAt: null, isNew: true });
              }}
              disabled={atCapacity}
              className="rounded-sm border border-violet/50 px-4 py-2 text-xs uppercase tracking-wider text-violet disabled:opacity-40"
            >
              Preview email
            </button>
            <button
              onClick={() => {
                if (atCapacity) {
                  toast.error(
                    `All ${seats?.limit ?? 0} staff seats are in use. Free a seat or upgrade your plan.`,
                  );
                  return;
                }
                invite.mutate();
              }}
              disabled={invite.isPending || atCapacity}
              className="rounded-sm bg-violet px-4 py-2 text-xs uppercase tracking-wider text-paper disabled:opacity-50"
            >
              {invite.isPending ? "Inviting…" : "Invite"}
            </button>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            An invite is claimed by matching the staff member's own confirmed email — there is no
            secret link. Tell them to sign up at <span className="mono">/auth</span> with this exact
            address; after confirming their email they're routed to{" "}
            <a href="/accept-invite" className="underline">
              /accept-invite
            </a>{" "}
            automatically.
          </p>
        </>
      )}

      <div className="mt-5">
        <div className="mono text-[10px] uppercase tracking-widest text-moss">
          Invites ({filtered.length}
          {filtered.length !== rows.length ? ` of ${rows.length}` : ""})
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-2">
          {(["all", "pending", "accepted", "expired"] as const).map((t) => (
            <button
              key={t}
              onClick={() => changeTab(t)}
              className={`mono rounded-sm border px-2.5 py-1 text-[10px] uppercase tracking-widest transition-colors ${
                tab === t
                  ? "border-violet bg-violet/15 text-violet"
                  : "border-border text-muted-foreground hover:text-foreground"
              }`}
            >
              {t} ({counts[t]})
            </button>
          ))}
        </div>

        <input
          type="search"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(0);
          }}
          placeholder="Search by email…"
          className="mt-2 w-full rounded-sm border border-border bg-background px-3 py-2 text-sm sm:max-w-xs"
        />

        {rows.length === 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">No invites yet.</p>
        ) : filtered.length === 0 ? (
          <p className="mt-3 text-xs text-muted-foreground">
            No {tab === "all" ? "" : `${tab} `}invites match “{search.trim()}”.
          </p>
        ) : (
          <div className="mt-2 space-y-2">
            {paged.map((m) => {
              const status = statusOf(m);
              return (
                <div
                  key={m.id}
                  className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-2"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span
                        className={`mono rounded-sm border px-2 py-0.5 text-[10px] uppercase tracking-widest ${STATUS_STYLE[status]}`}
                      >
                        {status}
                      </span>
                      <span className="truncate text-sm">{m.invited_email}</span>
                    </div>
                    <div className="mono mt-1 text-[10px] uppercase tracking-widest text-muted-foreground">
                      {m.role} · invited {fmt(m.invited_at)}
                      {status === "accepted"
                        ? ` · accepted ${fmt(m.accepted_at)}`
                        : ` · ${status === "expired" ? "expired" : "expires"} ${fmt(m.expires_at)}`}
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    {status !== "accepted" && (
                      <>
                        <button
                          onClick={() => resend.mutate(m)}
                          disabled={resend.isPending}
                          className="rounded-sm border border-violet/50 px-3 py-1 text-[10px] uppercase tracking-widest text-violet disabled:opacity-50"
                        >
                          Resend (+7 days)
                        </button>
                        <button
                          onClick={() =>
                            setPreview({
                              email: m.invited_email,
                              expiresAt: m.expires_at,
                              isNew: false,
                            })
                          }
                          className="rounded-sm border border-border px-3 py-1 text-[10px] uppercase tracking-widest text-muted-foreground hover:text-foreground"
                        >
                          Preview email
                        </button>
                        <button
                          onClick={() => copyInstructions(m)}
                          className="rounded-sm border border-border px-3 py-1 text-[10px] uppercase tracking-widest text-muted-foreground hover:text-foreground"
                        >
                          Copy instructions
                        </button>
                      </>
                    )}
                    <button
                      onClick={() => {
                        const msg = m.accepted_at
                          ? `Remove ${m.invited_email}'s access immediately?`
                          : `Revoke the invite for ${m.invited_email}?`;
                        if (!window.confirm(msg)) return;
                        revoke.mutate(m);
                      }}
                      disabled={revoke.isPending}
                      className="rounded-sm border border-border px-3 py-1 text-[10px] uppercase tracking-widest text-muted-foreground hover:text-foreground disabled:opacity-50"
                    >
                      {m.accepted_at ? "Remove access" : "Revoke"}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {filtered.length > PAGE_SIZE && (
          <div className="mono mt-3 flex items-center justify-between border-t border-border pt-2 text-[10px] uppercase tracking-widest">
            <span className="text-muted-foreground">
              {safePage * PAGE_SIZE + 1}–{safePage * PAGE_SIZE + paged.length} of {filtered.length}
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPage(Math.max(0, safePage - 1))}
                disabled={safePage === 0}
                className="rounded-sm border border-border px-3 py-1 text-muted-foreground hover:text-foreground disabled:opacity-40"
              >
                Prev
              </button>
              <span className="text-moss">
                {safePage + 1}/{pageCount}
              </span>
              <button
                onClick={() => setPage(Math.min(pageCount - 1, safePage + 1))}
                disabled={safePage >= pageCount - 1}
                className="rounded-sm border border-border px-3 py-1 text-muted-foreground hover:text-foreground disabled:opacity-40"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>


      {preview && (
        <InviteEmailPreviewDialog
          open
          onOpenChange={(o) => !o && setPreview(null)}
          invitedEmail={preview.email}
          businessName={businessName ?? ""}
          expiresAt={preview.expiresAt}
          onConfirm={preview.isNew ? () => invite.mutate() : undefined}
          confirmPending={invite.isPending}
        />
      )}

      {isStandard && (
        <div className="mt-6 border-t border-border pt-4">
          <div className="mono text-[10px] uppercase tracking-widest text-moss">
            Invite audit log ({timeline.length})
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Append-only record of every invite action — created, resent, accepted, revoked, plus
            expiries derived from the 7-day window.
          </p>
          {timeline.length === 0 ? (
            <p className="mt-2 text-xs text-muted-foreground">No invite activity recorded yet.</p>
          ) : (
            <div className="mono mt-3 space-y-1 text-[11px]">
              {timeline.map((e) => (
                <div
                  key={e.id}
                  className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-border/50 pb-1"
                >
                  <span className="text-muted-foreground">{fmtStamp(e.occurred_at)}</span>
                  <span
                    className={`uppercase tracking-widest ${EVENT_STYLE[e.event_type] ?? "text-muted-foreground"}`}
                  >
                    {e.event_type}
                  </span>
                  <span className="truncate text-paper">{e.invited_email}</span>
                  <span className="text-muted-foreground">{e.detail ?? "—"}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
