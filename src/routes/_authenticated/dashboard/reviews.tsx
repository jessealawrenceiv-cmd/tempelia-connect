import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader } from "@/components/AppShell";
import { useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { sendReviewRequest } from "@/lib/sms.functions";

export const Route = createFileRoute("/_authenticated/dashboard/reviews")({
  component: ReviewsPage,
});

const phoneSchema = z.string().trim().regex(/^\+?[1-9]\d{7,14}$/, "Use E.164 format e.g. +15551234567");
const moneySchema = z.union([
  z.string().trim().regex(/^\d+(\.\d{1,2})?$/),
  z.number().nonnegative(),
]);

function formatCurrency(n: number | null | undefined) {
  if (n == null) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
}

function statusBadge(status: string) {
  switch (status) {
    case "review_requested":
      return <span className="rounded-sm bg-moss/20 px-2 py-0.5 text-[10px] uppercase tracking-wider text-moss-foreground">Requested</span>;
    case "pending":
      return <span className="rounded-sm bg-steel/20 px-2 py-0.5 text-[10px] uppercase tracking-wider text-steel-foreground">Pending</span>;
    case "needs_consent":
      return <span className="rounded-sm bg-orange-500/20 px-2 py-0.5 text-[10px] uppercase tracking-wider text-orange-500">Needs consent</span>;
    case "failed":
      return <span className="rounded-sm bg-destructive/20 px-2 py-0.5 text-[10px] uppercase tracking-wider text-destructive-foreground">Failed</span>;
    default:
      return <span className="rounded-sm bg-muted px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">{status}</span>;
  }
}

function ReviewsPage() {
  const qc = useQueryClient();

  const { data: customers } = useQuery({
    queryKey: ["customers"],
    queryFn: async () => {
      const { data } = await supabase.from("customers").select("*").order("created_at", { ascending: false });
      return data ?? [];
    },
  });

  const { data: jobs } = useQuery({
    queryKey: ["jobs"],
    queryFn: async () => {
      const { data } = await supabase
        .from("jobs")
        .select("id, customer_id, job_value, status, completed_at, customers(first_name, phone_number)")
        .order("completed_at", { ascending: false })
        .limit(50);
      return data ?? [];
    },
  });

  const [customerId, setCustomerId] = useState<string>("");
  const [jobValue, setJobValue] = useState<string>("");
  const [newName, setNewName] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [newConsent, setNewConsent] = useState(true);

  const sendReviewFn = useServerFn(sendReviewRequest);
  const complete = useMutation({
    mutationFn: async (chosenId: string) => {
      const value = jobValue.trim() ? Number(jobValue) : undefined;
      return sendReviewFn({ data: { customerId: chosenId, jobValue: value } });
    },
    onSuccess: () => {
      toast.success("Job marked complete and review request sent.");
      setJobValue("");
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

  const totalJobValue = jobs?.reduce((sum, j) => sum + (j.job_value ?? 0), 0) ?? 0;

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

            <label className="block">
              <span className="label-eyebrow">Job value (optional)</span>
              <div className="relative mt-1">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={jobValue}
                  onChange={(e) => setJobValue(e.target.value)}
                  placeholder="0.00"
                  className="mono block w-full rounded-sm border border-border bg-background py-2 pl-7 pr-3 text-sm"
                />
              </div>
            </label>

            <button
              disabled={!customerId || complete.isPending}
              onClick={() => complete.mutate(customerId)}
              className="w-full rounded-sm bg-primary px-4 py-3 text-sm font-medium uppercase tracking-wider text-primary-foreground hover:opacity-90 disabled:opacity-50"
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
              <input type="checkbox" checked={newConsent} onChange={(e) => setNewConsent(e.target.checked)} className="h-4 w-4 accent-primary" />
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
          <div className="flex items-center justify-between">
            <div className="label-eyebrow">Completed jobs</div>
            <div className="mono text-xs text-muted-foreground">Total: {formatCurrency(totalJobValue)}</div>
          </div>
          <ul className="mono mt-4 max-h-[560px] divide-y divide-border overflow-y-auto text-xs">
            {jobs?.length === 0 && <li className="py-4 text-muted-foreground">No completed jobs yet.</li>}
            {jobs?.map((j: any) => (
              <li key={j.id} className="py-3">
                <div className="flex items-center justify-between">
                  <span className="font-semibold">{j.customers?.first_name || "Customer"}</span>
                  {statusBadge(j.status)}
                </div>
                <div className="flex items-center justify-between text-muted-foreground">
                  <span>{j.customers?.phone_number}</span>
                  <span>{formatCurrency(j.job_value)}</span>
                </div>
                <div className="mt-1 text-muted-foreground">
                  {j.completed_at ? new Date(j.completed_at).toLocaleString() : "—"}
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
