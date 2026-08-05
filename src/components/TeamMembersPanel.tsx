import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";

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
  const isStandard = tier === "standard";

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
      const { error } = await supabase
        .from("team_members")
        .insert({ business_owner_id: u.user.id, invited_email: addr, role: "staff" });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Invite created. Tell them to sign in with that exact email address.");
      setEmail("");
      qc.invalidateQueries({ queryKey: ["team_members"] });
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
      return m;
    },
    onSuccess: (m) => {
      toast.success(`Invite for ${m.invited_email} extended 7 more days.`);
      qc.invalidateQueries({ queryKey: ["team_members"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const revoke = useMutation({
    mutationFn: async (m: Member) => {
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
            Starter is limited to a single login. Upgrade to{" "}
            <span className="uppercase">Standard</span> to invite staff members with their own
            credentials.
          </p>
        </div>
      ) : (
        <>
          <div className="mt-4 flex flex-col gap-2 sm:flex-row">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="staff@example.com"
              className="w-full rounded-sm border border-border bg-background px-3 py-2 text-sm"
            />
            <button
              onClick={() => invite.mutate()}
              disabled={invite.isPending}
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
          All invites ({rows.length})
        </div>
        {rows.length === 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">No invites yet.</p>
        ) : (
          <div className="mt-2 space-y-2">
            {rows.map((m) => {
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
      </div>
    </div>
  );
}
