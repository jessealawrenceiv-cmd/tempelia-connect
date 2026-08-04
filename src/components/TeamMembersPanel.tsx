import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";

/**
 * Team accounts panel (owner-only). Invites are Standard-tier only; the
 * database enforces the gate too, so Starter attempts fail server-side.
 */
export function TeamMembersPanel({ tier }: { tier: string | null | undefined }) {
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const isStandard = tier === "standard";

  const { data: members } = useQuery({
    queryKey: ["team_members"],
    queryFn: async () => {
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) return [];
      const { data, error } = await supabase
        .from("team_members")
        .select("*")
        .eq("business_owner_id", u.user.id)
        .order("invited_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
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
      toast.success("Invite created. Send them the accept link below.");
      setEmail("");
      qc.invalidateQueries({ queryKey: ["team_members"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const acceptUrl = () =>
    `${typeof window !== "undefined" ? window.location.origin : ""}/accept-invite`;

  const resend = useMutation({
    mutationFn: async (m: { id: string; invited_email: string }) => {
      const { error } = await supabase
        .from("team_members")
        .update({ invited_at: new Date().toISOString() })
        .eq("id", m.id);


      if (error) throw error;
      const link = acceptUrl();
      try {
        await navigator.clipboard.writeText(link);
        return { link, copied: true, email: m.invited_email };
      } catch {
        return { link, copied: false, email: m.invited_email };
      }
    },
    onSuccess: (r) => {
      toast.success(
        r.copied
          ? `Accept link copied — send it to ${r.email}.`
          : `Accept link regenerated: ${r.link}`,
      );
      qc.invalidateQueries({ queryKey: ["team_members"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const revoke = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("team_members").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Access revoked.");
      qc.invalidateQueries({ queryKey: ["team_members"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });


  return (
    <div className="panel p-6">
      <div className="label-eyebrow">Team accounts</div>
      <h2 className="mt-1 text-xl">Staff logins</h2>

      {!isStandard ? (
        <div className="mt-3 rounded-sm border border-violet/40 bg-violet/10 p-4">
          <div className="mono text-[10px] uppercase tracking-widest text-violet">Upgrade required</div>
          <p className="mt-2 text-xs text-muted-foreground">
            Starter is limited to a single login. Upgrade to <span className="uppercase">Standard</span> to invite
            staff members with their own credentials.
          </p>
        </div>
      ) : (
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
      )}

      {isStandard && (
        <p className="mt-3 text-xs text-muted-foreground">
          Ask staff to sign in with the invited email, confirm it from their inbox, then open{" "}
          <a href="/accept-invite" className="underline">
            /accept-invite
          </a>{" "}
          to activate access.
        </p>
      )}


      <div className="mt-5 space-y-2">
        {(members ?? []).length === 0 && (
          <p className="text-xs text-muted-foreground">No staff logins yet.</p>
        )}
        {(members ?? []).map((m) => (
          <div key={m.id} className="flex items-center justify-between gap-3 border-t border-border pt-2">
            <div className="min-w-0">
              <div className="truncate text-sm">{m.invited_email}</div>
              <div className="mono text-[10px] uppercase tracking-widest text-muted-foreground">
                {m.role} · {m.accepted_at ? `accepted ${new Date(m.accepted_at).toLocaleDateString()}` : "pending"}
              </div>
            </div>
            <button
              onClick={() => revoke.mutate(m.id)}
              className="shrink-0 rounded-sm border border-border px-3 py-1 text-[10px] uppercase tracking-widest text-muted-foreground hover:text-foreground"
            >
              Revoke
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
