import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

export function ExcludedNumbersPanel() {
  const qc = useQueryClient();
  const [phone, setPhone] = useState("");
  const [label, setLabel] = useState("");

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ["excluded_numbers"],
    queryFn: async () => {
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) return [];
      const { data, error } = await supabase
        .from("excluded_numbers")
        .select("id, phone_number, label, created_at")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });

  const add = useMutation({
    mutationFn: async () => {
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) throw new Error("Not signed in");
      const cleaned = phone.trim();
      if (!cleaned) throw new Error("Phone number required");
      const { error } = await supabase.from("excluded_numbers").insert({
        user_id: u.user.id,
        phone_number: cleaned,
        label: label.trim() || null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Number excluded.");
      setPhone("");
      setLabel("");
      qc.invalidateQueries({ queryKey: ["excluded_numbers"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("excluded_numbers").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Removed.");
      qc.invalidateQueries({ queryKey: ["excluded_numbers"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="panel p-6 md:col-span-2">
      <div className="label-eyebrow">Do-not-text list</div>
      <h2 className="mt-1 text-xl">Excluded numbers</h2>
      <p className="mt-2 text-xs text-muted-foreground">
        Callers on this list will not receive the missed-call auto-text. Use E.164 format (e.g. +14155551234).
      </p>

      <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
        <input
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="+14155551234"
          className="mono rounded-sm border border-border bg-background px-3 py-2 text-sm"
        />
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Label (optional)"
          className="mono rounded-sm border border-border bg-background px-3 py-2 text-sm"
        />
        <button
          onClick={() => add.mutate()}
          disabled={add.isPending}
          className="rounded-sm bg-primary px-4 py-2 text-sm font-medium uppercase tracking-wider text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {add.isPending ? "Adding…" : "Add"}
        </button>
      </div>

      <ul className="mono mt-5 divide-y divide-border text-xs">
        {isLoading && <li className="py-3 text-muted-foreground">Loading…</li>}
        {!isLoading && rows.length === 0 && (
          <li className="py-3 text-muted-foreground">No excluded numbers yet.</li>
        )}
        {rows.map((r) => (
          <li key={r.id} className="flex items-center justify-between gap-3 py-3">
            <div>
              <div className="text-foreground">{r.phone_number}</div>
              {r.label && <div className="text-[10px] uppercase tracking-widest text-muted-foreground">{r.label}</div>}
            </div>
            <button
              onClick={() => remove.mutate(r.id)}
              disabled={remove.isPending}
              className="rounded-sm border border-border px-3 py-1.5 text-[10px] uppercase tracking-widest text-muted-foreground hover:bg-card"
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
