import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader } from "@/components/AppShell";
import { useState } from "react";
import { toast } from "sonner";
import { z } from "zod";

export const Route = createFileRoute("/_authenticated/dashboard/reviews")({
  component: ReviewsPage,
});

const phoneSchema = z.string().trim().regex(/^\+?[1-9]\d{7,14}$/, "Use E.164 format e.g. +15551234567");

function ReviewsPage() {
  const qc = useQueryClient();

  const { data: customers } = useQuery({
    queryKey: ["customers"],
    queryFn: async () => {
      const { data } = await supabase.from("customers").select("*").order("created_at", { ascending: false });
      return data ?? [];
    },
  });

  const { data: recent } = useQuery({
    queryKey: ["review-logs"],
    queryFn: async () => {
      const { data } = await supabase
        .from("logs")
        .select("id, message_sent, created_at, customers(first_name, phone_number)")
        .eq("action_type", "review_request")
        .order("created_at", { ascending: false })
        .limit(50);
      return data ?? [];
    },
  });

  const [customerId, setCustomerId] = useState<string>("");
  const [newName, setNewName] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [newConsent, setNewConsent] = useState(true);

  const complete = useMutation({
    mutationFn: async (chosenId: string) => {
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) throw new Error("Not signed in");
      const { data: cust } = await supabase.from("customers").select("*").eq("id", chosenId).maybeSingle();
      if (!cust) throw new Error("Customer not found");
      const { data: intg } = await supabase.from("integrations").select("google_review_url").eq("user_id", u.user.id).maybeSingle();
      const { data: prof } = await supabase.from("profiles").select("business_name").eq("id", u.user.id).maybeSingle();
      const biz = prof?.business_name || "our team";
      const url = intg?.google_review_url || "[set your Google review link in Settings]";
      const msg = `Thanks for choosing ${biz}! Mind leaving us a quick review? ${url}\n\nReply STOP to unsubscribe.`;

      if (!cust.opt_in_consent) {
        await supabase.from("logs").insert({
          user_id: u.user.id, customer_id: cust.id, action_type: "review_request",
          message_sent: msg, status: "needs_consent",
        });
        throw new Error(`${cust.first_name || "Customer"} has not opted in. Flagged as needs-consent.`);
      }

      // Mark last_service_date = today so reactivation clock resets
      await supabase.from("customers").update({ last_service_date: new Date().toISOString().slice(0, 10) }).eq("id", cust.id);
      await supabase.from("logs").insert({
        user_id: u.user.id, customer_id: cust.id, action_type: "review_request",
        message_sent: msg, status: "queued",
      });
    },
    onSuccess: () => {
      toast.success("Review request queued.");
      qc.invalidateQueries();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const addCustomer = useMutation({
    mutationFn: async () => {
      const phone = phoneSchema.parse(newPhone);
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) throw new Error("Not signed in");
      const { data, error } = await supabase.from("customers").insert({
        user_id: u.user.id, first_name: newName.trim(), phone_number: phone, opt_in_consent: newConsent,
      }).select().single();
      if (error) throw error;
      return data;
    },
    onSuccess: (data) => {
      toast.success("Customer added");
      setNewName(""); setNewPhone(""); setNewConsent(true);
      setCustomerId(data.id);
      qc.invalidateQueries({ queryKey: ["customers"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div>
      <PageHeader eyebrow="Feature 02" title="Review booster" />
      <div className="grid gap-5 p-5 md:grid-cols-[1.1fr_1fr] md:p-8">
        <div className="panel p-5">
          <div className="label-eyebrow">Mark a job complete</div>
          <h2 className="mt-1 text-xl">Send review request</h2>

          <div className="mt-4 space-y-3">
            <label className="block">
              <span className="label-eyebrow">Customer</span>
              <select
                value={customerId}
                onChange={(e) => setCustomerId(e.target.value)}
                className="mono mt-1 block w-full rounded-sm border border-border bg-background px-3 py-2 text-sm"
              >
                <option value="">— pick a customer —</option>
                {customers?.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.first_name || "Unnamed"} · {c.phone_number} {c.opt_in_consent ? "" : "· (needs consent)"}
                  </option>
                ))}
              </select>
            </label>
            <button
              disabled={!customerId || complete.isPending}
              onClick={() => complete.mutate(customerId)}
              className="w-full rounded-sm bg-orange px-4 py-3 text-sm font-medium uppercase tracking-wider text-orange-foreground hover:opacity-90 disabled:opacity-50"
            >
              {complete.isPending ? "Sending…" : "Mark complete & send"}
            </button>
          </div>

          <div className="mt-8 border-t border-border pt-6">
            <div className="label-eyebrow">Or add a new customer</div>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="First name" className="mono rounded-sm border border-border bg-background px-3 py-2 text-sm" />
              <input value={newPhone} onChange={(e) => setNewPhone(e.target.value)} placeholder="+15551234567" className="mono rounded-sm border border-border bg-background px-3 py-2 text-sm" />
            </div>
            <label className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
              <input type="checkbox" checked={newConsent} onChange={(e) => setNewConsent(e.target.checked)} className="h-4 w-4 accent-orange" />
              Customer has verbally opted in to SMS
            </label>
            <button
              disabled={!newPhone || addCustomer.isPending}
              onClick={() => addCustomer.mutate()}
              className="mt-3 w-full rounded-sm border border-border bg-card px-4 py-2 text-sm uppercase tracking-wider hover:bg-accent disabled:opacity-50"
            >
              {addCustomer.isPending ? "Adding…" : "Add customer"}
            </button>
          </div>
        </div>

        <div className="panel p-5">
          <div className="label-eyebrow">Recent review requests</div>
          <ul className="mono mt-4 max-h-[560px] divide-y divide-border overflow-y-auto text-xs">
            {recent?.length === 0 && <li className="py-4 text-muted-foreground">Nothing sent yet.</li>}
            {recent?.map((r: any) => (
              <li key={r.id} className="py-3">
                <div className="flex items-center justify-between">
                  <span className="font-semibold">{r.customers?.first_name || "Customer"}</span>
                  <span className="text-muted-foreground">{new Date(r.created_at).toLocaleString()}</span>
                </div>
                <div className="text-muted-foreground">{r.customers?.phone_number}</div>
                <div className="mt-1 line-clamp-2 text-foreground/80">{r.message_sent}</div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
