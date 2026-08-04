import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/accept-invite")({
  ssr: false,
  component: AcceptInvitePage,
  head: () => ({
    meta: [
      { title: "Accept team invite — Temaro" },
      { name: "description", content: "Accept your Temaro team invite and get access to your business dashboard." },
      { property: "og:title", content: "Accept team invite — Temaro" },
      { property: "og:description", content: "Accept your Temaro team invite and get access to your business dashboard." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: "noindex" },
    ],
  }),
});

type PendingInvite = {
  invite_id: string;
  business_owner_id: string;
  business_name: string;
  invited_at: string;
  expires_at: string;
};

type State =
  | { kind: "loading" }
  | { kind: "signed_out" }
  | { kind: "unconfirmed"; email: string }
  | { kind: "choose"; email: string; invites: PendingInvite[] }
  | { kind: "accepted"; email: string; justClaimed: boolean }
  | { kind: "expired"; email: string }
  | { kind: "not_found"; email: string }
  | { kind: "error"; message: string };


function AcceptInvitePage() {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [claiming, setClaiming] = useState<string | null>(null);

  const finish = useCallback(async (email: string, userId: string, justClaimed: boolean) => {
    const { data: membership, error: memberError } = await supabase
      .from("team_members")
      .select("business_owner_id, accepted_at")
      .eq("staff_user_id", userId)
      .not("accepted_at", "is", null)
      .limit(1);
    if (memberError) return setState({ kind: "error", message: memberError.message });

    if (membership && membership.length > 0) {
      setState({ kind: "accepted", email, justClaimed });
      return;
    }

    // No active access: distinguish an expired invite from no invite at all.
    const { data: expired } = await supabase.rpc("has_expired_team_invite");
    if (expired === true) {
      setState({ kind: "expired", email });
    } else {
      setState({ kind: "not_found", email });
    }

  }, []);

  const run = useCallback(async () => {
    setState({ kind: "loading" });
    const { data: u } = await supabase.auth.getUser();
    const user = u.user;
    if (!user) return setState({ kind: "signed_out" });
    const email = user.email ?? "";

    if (!user.email_confirmed_at) return setState({ kind: "unconfirmed", email });

    const { data: pending, error: listError } = await supabase.rpc("list_pending_team_invites");
    if (listError) return setState({ kind: "error", message: listError.message });

    const invites = (pending ?? []) as PendingInvite[];

    // Multiple businesses invited this address — the invitee must pick one.
    if (invites.length > 1) return setState({ kind: "choose", email, invites });

    let justClaimed = false;
    if (invites.length === 1) {
      const { data: ok, error: rpcError } = await supabase.rpc("claim_team_invite", {
        _invite_id: invites[0].invite_id,
      });
      if (rpcError) return setState({ kind: "error", message: rpcError.message });
      justClaimed = ok === true;
    }

    await finish(email, user.id, justClaimed);
  }, [finish]);

  const claimOne = useCallback(
    async (invite: PendingInvite, email: string) => {
      setClaiming(invite.invite_id);
      const { data: ok, error } = await supabase.rpc("claim_team_invite", {
        _invite_id: invite.invite_id,
      });
      setClaiming(null);
      if (error) return setState({ kind: "error", message: error.message });
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) return setState({ kind: "signed_out" });
      await finish(email, u.user.id, ok === true);
    },
    [finish],
  );


  useEffect(() => {
    void run();
  }, [run]);

  return (
    <div className="min-h-screen bg-background">
      <div className="border-b border-border bg-charcoal text-paper">
        <div className="mx-auto flex max-w-6xl items-center gap-2 px-4 py-4">
          <a href="/" className="flex items-center gap-2">
            <img src="/logo-icon.png" alt="" className="h-9 w-auto" />
            <span className="font-display text-xl font-bold uppercase tracking-wider">Temaro</span>
          </a>
        </div>
      </div>

      <div className="mx-auto grid min-h-[calc(100vh-72px)] max-w-5xl place-items-center px-4 py-10">
        <div className="panel w-full max-w-md p-8">
          <div className="label-eyebrow">Team invite</div>
          <h1 className="mt-2 text-3xl">Accept your invite</h1>

          {state.kind === "loading" && (
            <p className="mono mt-6 text-xs uppercase tracking-widest text-muted-foreground">
              Checking invite status…
            </p>
          )}

          {state.kind === "signed_out" && (
            <>
              <p className="mt-4 text-sm text-muted-foreground">
                Sign in with the exact email address your invite was sent to. If you don't have an
                account yet, create one with that same email and confirm it from your inbox.
              </p>
              <div className="mt-6 flex flex-col gap-2">
                <Link
                  to="/auth"
                  search={{ mode: "signin", next: "/accept-invite" }}
                  className="rounded-sm bg-orange px-4 py-3 text-center text-xs uppercase tracking-wider text-paper"
                >
                  Sign in
                </Link>
                <Link
                  to="/auth"
                  search={{ mode: "signup", next: "/accept-invite" }}
                  className="rounded-sm border border-border px-4 py-3 text-center text-xs uppercase tracking-wider text-muted-foreground hover:text-foreground"
                >
                  Create an account
                </Link>
              </div>
            </>
          )}

          {state.kind === "unconfirmed" && (
            <>
              <StatusLine tone="pending">Email not confirmed</StatusLine>
              <p className="mt-3 text-sm text-muted-foreground">
                We sent a confirmation link to <span className="mono">{state.email}</span>. Click it,
                then return here — invites only link to confirmed email addresses.
              </p>
              <RetryButton onClick={run} label="I've confirmed — check again" />
            </>
          )}
          {state.kind === "choose" && (
            <>
              <StatusLine tone="pending">Multiple invites found</StatusLine>
              <p className="mt-3 text-sm text-muted-foreground">
                <span className="mono">{state.email}</span> was invited by more than one business.
                Pick the one you're joining — you can only have staff access to one business at a
                time.
              </p>
              <div className="mt-6 flex flex-col gap-2">
                {state.invites.map((inv) => (
                  <button
                    key={inv.invite_id}
                    disabled={claiming !== null}
                    onClick={() => void claimOne(inv, state.email)}
                    className="flex items-center justify-between rounded-sm border border-violet/60 px-4 py-3 text-left hover:bg-violet/10 disabled:opacity-50"
                  >
                    <span className="text-sm text-foreground">
                      {inv.business_name || "Unnamed business"}
                    </span>
                    <span className="mono text-[10px] uppercase tracking-widest text-muted-foreground">
                      {claiming === inv.invite_id
                        ? "joining…"
                        : `invited ${new Date(inv.invited_at).toLocaleDateString()}`}
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}


          {state.kind === "accepted" && (
            <>
              <StatusLine tone="ok">
                {state.justClaimed ? "Invite accepted" : "Access already active"}
              </StatusLine>
              <p className="mt-3 text-sm text-muted-foreground">
                <span className="mono">{state.email}</span> now has staff access to your business
                dashboard. Settings, billing, and excluded numbers stay with the owner.
              </p>
              <Link
                to="/dashboard"
                className="mt-6 block rounded-sm bg-orange px-4 py-3 text-center text-xs uppercase tracking-wider text-paper"
              >
                Go to dashboard
              </Link>
            </>
          )}

          {state.kind === "not_found" && (
            <>
              <StatusLine tone="pending">No invite found</StatusLine>
              <p className="mt-3 text-sm text-muted-foreground">
                There's no pending invite for <span className="mono">{state.email}</span>. Ask the
                business owner to invite that exact address, then check again.
              </p>
              <RetryButton onClick={run} label="Check again" />
            </>
          )}

          {state.kind === "error" && (
            <>
              <StatusLine tone="error">Couldn't complete</StatusLine>
              <p className="mt-3 text-sm text-muted-foreground">{state.message}</p>
              <RetryButton onClick={run} label="Try again" />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function StatusLine({ tone, children }: { tone: "ok" | "pending" | "error"; children: React.ReactNode }) {
  const color =
    tone === "ok" ? "text-moss" : tone === "error" ? "text-destructive" : "text-orange";
  return (
    <div className={`mono mt-6 text-[10px] uppercase tracking-widest ${color}`}>{children}</div>
  );
}

function RetryButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      className="mt-6 w-full rounded-sm border border-border px-4 py-3 text-xs uppercase tracking-wider text-muted-foreground hover:text-foreground"
    >
      {label}
    </button>
  );
}
