import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";

// Beta namespace typing shim.
type AuthorizationClient = { name?: string; redirect_uri?: string } | null | undefined;
type AuthorizationDetails = {
  client?: AuthorizationClient;
  scope?: string;
  redirect_url?: string;
  redirect_to?: string;
} | null;

type OAuthResult = {
  redirect_url?: string;
  redirect_to?: string;
};

type SupabaseOAuth = {
  getAuthorizationDetails: (id: string) => Promise<{ data: AuthorizationDetails; error: { message: string } | null }>;
  approveAuthorization: (id: string) => Promise<{ data: OAuthResult | null; error: { message: string } | null }>;
  denyAuthorization: (id: string) => Promise<{ data: OAuthResult | null; error: { message: string } | null }>;
};

function oauthClient(): SupabaseOAuth {
  return (supabase.auth as unknown as { oauth: SupabaseOAuth }).oauth;
}

export const Route = createFileRoute("/.lovable/oauth/consent")({
  ssr: false,
  validateSearch: (s: Record<string, unknown>) => ({
    authorization_id: typeof s.authorization_id === "string" ? s.authorization_id : "",
  }),
  beforeLoad: async ({ search, location }) => {
    if (!search.authorization_id) throw new Error("Missing authorization_id");
    const { data } = await supabase.auth.getSession();
    if (!data.session) {
      const next = location.pathname + location.searchStr;
      throw redirect({ to: "/auth", search: { next } });
    }
  },
  loader: async ({ location }) => {
    const authorizationId = new URLSearchParams(location.search).get("authorization_id")!;
    const { data, error } = await oauthClient().getAuthorizationDetails(authorizationId);
    if (error) throw new Error(error.message);
    const immediate = data?.redirect_url ?? data?.redirect_to;
    if (immediate && !data?.client) throw redirect({ href: immediate });
    return data;
  },
  component: Consent,
  errorComponent: ({ error }) => (
    <main className="mx-auto max-w-md p-8 text-paper">
      <h1 className="text-xl">Authorization error</h1>
      <p className="mt-2 text-sm text-muted-foreground">{String((error as Error)?.message ?? error)}</p>
    </main>
  ),
});

function Consent() {
  const details = Route.useLoaderData();
  const { authorization_id } = Route.useSearch();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decide(approve: boolean) {
    setBusy(true);
    setError(null);
    const oauth = oauthClient();
    const { data, error } = approve
      ? await oauth.approveAuthorization(authorization_id)
      : await oauth.denyAuthorization(authorization_id);
    if (error) {
      setBusy(false);
      setError(error.message);
      return;
    }
    const target = data?.redirect_url ?? data?.redirect_to;
    if (!target) {
      setBusy(false);
      setError("No redirect returned by the authorization server.");
      return;
    }
    window.location.href = target;
  }

  const clientName = details?.client?.name ?? "an app";
  const redirectUri = details?.client?.redirect_uri;

  return (
    <main className="min-h-screen bg-background">
      <div className="border-b border-border bg-charcoal text-paper">
        <div className="mx-auto flex max-w-6xl items-center gap-2 px-4 py-4">
          <img src="/logo-icon.png" alt="" className="h-9 w-auto" />
          <span className="font-display text-xl font-bold uppercase tracking-wider">Temora</span>
        </div>
      </div>
      <div className="mx-auto grid min-h-[calc(100vh-72px)] max-w-5xl place-items-center px-4 py-10">
        <div className="panel w-full max-w-md p-8">
          <div className="label-eyebrow">Agent access</div>
          <h1 className="mt-2 text-2xl">Connect {clientName} to your account</h1>
          <p className="mt-3 text-sm text-muted-foreground">
            This lets {clientName} use Temora as you. It can call the enabled tools on this
            account (contacts, quotes, appointments, and dispatch activity) while you are
            signed in. This does not bypass Temora's permissions or your data policies.
          </p>
          {redirectUri && (
            <div className="mt-4 rounded-sm border border-border bg-card/40 p-3">
              <div className="label-eyebrow text-[10px]">Authorization will be sent to</div>
              <p className="mono mt-1 break-all text-xs text-paper">{redirectUri}</p>
              <p className="mt-2 text-[11px] text-muted-foreground">
                Only approve if you recognize this destination. If it looks wrong, cancel.
              </p>
            </div>
          )}
          {details?.scope && (
            <p className="mono mt-3 text-[10px] uppercase tracking-widest text-muted-foreground">
              Requested scope: {details.scope}
            </p>
          )}
          {error && (
            <p role="alert" className="mono mt-4 rounded-sm border border-orange bg-orange/10 p-3 text-xs text-orange">
              {error}
            </p>
          )}
          <div className="mt-6 flex gap-3">
            <button
              disabled={busy}
              onClick={() => decide(true)}
              className="flex-1 rounded-sm bg-orange px-4 py-3 text-sm font-medium uppercase tracking-wider text-orange-foreground hover:opacity-90 disabled:opacity-50"
            >
              {busy ? "Working…" : "Approve"}
            </button>
            <button
              disabled={busy}
              onClick={() => decide(false)}
              className="flex-1 rounded-sm border border-border bg-card px-4 py-3 text-sm uppercase tracking-wider text-muted-foreground hover:bg-muted"
            >
              Cancel connection
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}
