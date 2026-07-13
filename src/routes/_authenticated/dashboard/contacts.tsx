import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader } from "@/components/AppShell";
import { CustomerHistory } from "@/components/CustomerHistory";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";

export const Route = createFileRoute("/_authenticated/dashboard/contacts")({
  component: ContactsPage,
});


const phoneSchema = z.string().trim().regex(/^\+?[1-9]\d{7,14}$/, "Use E.164 format e.g. +15551234567");
const SOURCES = ["all", "intake", "manual", "seeded"] as const;
const SMS_FILTERS = ["all", "opted_in", "no_consent"] as const;
const FORM_FILTERS = ["all", "signed", "unsigned"] as const;

type Contact = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  phone_number: string;
  email: string | null;
  notes: string | null;
  source: string;
  opt_in_consent: boolean;
  sms_opt_in_at: string | null;
  consent_form_signed: boolean;
  consent_form_signed_at: string | null;
  created_at: string;
  last_service_date: string | null;
};

function fmtDate(s: string | null | undefined) {
  return s ? new Date(s).toLocaleDateString() : "—";
}

function sourceBadge(src: string) {
  const map: Record<string, string> = {
    intake: "bg-violet/20 text-paper",
    manual: "bg-steel/20 text-paper",
    seeded: "bg-muted text-muted-foreground",
  };
  return (
    <span className={`rounded-sm px-2 py-0.5 text-[10px] uppercase tracking-wider mono ${map[src] || "bg-muted text-muted-foreground"}`}>
      {src}
    </span>
  );
}

function ContactsPage() {
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [sourceFilter, setSourceFilter] = useState<(typeof SOURCES)[number]>("all");
  const [smsFilter, setSmsFilter] = useState<(typeof SMS_FILTERS)[number]>("all");
  const [formFilter, setFormFilter] = useState<(typeof FORM_FILTERS)[number]>("all");
  const [since, setSince] = useState<string>("");
  const [editing, setEditing] = useState<Contact | null>(null);
  const [showNew, setShowNew] = useState(false);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleExpand = (id: string) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });


  const { data: contacts, isLoading } = useQuery({
    queryKey: ["contacts"],
    refetchOnWindowFocus: true,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("customers")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as Contact[];
    },
  });

  // Live updates: reflect new/changed contacts (including auto-promoted intakes) instantly.
  useEffect(() => {
    const channel = supabase
      .channel("customers:dashboard")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "customers" },
        () => qc.invalidateQueries({ queryKey: ["contacts"] }),
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [qc]);

  // Pull last review-request activity per contact
  const { data: lastReviewByContact } = useQuery({
    queryKey: ["contact-last-review"],
    queryFn: async () => {
      const { data } = await supabase
        .from("logs")
        .select("customer_id, action_type, status, created_at")
        .eq("action_type", "review_request")
        .order("created_at", { ascending: false })
        .limit(500);
      const map = new Map<string, { status: string; at: string }>();
      (data ?? []).forEach((l: any) => {
        if (l.customer_id && !map.has(l.customer_id)) {
          map.set(l.customer_id, { status: l.status, at: l.created_at });
        }
      });
      return map;
    },
  });

  // Most recent email-overwrite audit entry per contact (from quote flow).
  const { data: emailUpdateByContact } = useQuery({
    queryKey: ["contact-email-updates"],
    queryFn: async () => {
      const { data } = await supabase
        .from("logs")
        .select("customer_id, message_sent, created_at")
        .eq("action_type", "customer_email_updated")
        .order("created_at", { ascending: false })
        .limit(500);
      const map = new Map<string, { at: string; old: string | null; new: string | null }>();
      (data ?? []).forEach((l: any) => {
        if (!l.customer_id || map.has(l.customer_id)) return;
        let parsed: { old?: string; new?: string } = {};
        try { parsed = l.message_sent ? JSON.parse(l.message_sent) : {}; } catch { /* ignore */ }
        map.set(l.customer_id, { at: l.created_at, old: parsed.old ?? null, new: parsed.new ?? null });
      });
      return map;
    },
  });

  const filtered = useMemo(() => {
    if (!contacts) return [];
    const needle = q.trim().toLowerCase();
    const sinceDate = since ? new Date(since).getTime() : null;
    return contacts.filter((c) => {
      if (sourceFilter !== "all" && c.source !== sourceFilter) return false;
      if (smsFilter === "opted_in" && !c.opt_in_consent) return false;
      if (smsFilter === "no_consent" && c.opt_in_consent) return false;
      if (formFilter === "signed" && !c.consent_form_signed) return false;
      if (formFilter === "unsigned" && c.consent_form_signed) return false;
      if (sinceDate && new Date(c.created_at).getTime() < sinceDate) return false;
      if (needle) {
        const hay = [c.first_name, c.last_name, c.phone_number, c.email].filter(Boolean).join(" ").toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [contacts, q, sourceFilter, smsFilter, formFilter, since]);

  const del = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("customers").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Contact deleted");
      qc.invalidateQueries({ queryKey: ["contacts"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div>
      <PageHeader eyebrow="Roster" title="Contacts" />
      <div className="p-5 md:p-8 space-y-5">
        {/* Filters */}
        <div className="panel p-4">
          <div className="grid gap-3 md:grid-cols-[1.4fr_repeat(4,1fr)_auto]">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search name, phone, email…"
              className="mono rounded-sm border border-border bg-background px-3 py-2 text-sm"
            />
            <select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value as any)} className="mono rounded-sm border border-border bg-background px-2 py-2 text-xs uppercase tracking-wider">
              {SOURCES.map((s) => <option key={s} value={s}>source: {s}</option>)}
            </select>
            <select value={smsFilter} onChange={(e) => setSmsFilter(e.target.value as any)} className="mono rounded-sm border border-border bg-background px-2 py-2 text-xs uppercase tracking-wider">
              <option value="all">sms: all</option>
              <option value="opted_in">sms: opted in</option>
              <option value="no_consent">sms: no consent</option>
            </select>
            <select value={formFilter} onChange={(e) => setFormFilter(e.target.value as any)} className="mono rounded-sm border border-border bg-background px-2 py-2 text-xs uppercase tracking-wider">
              <option value="all">form: all</option>
              <option value="signed">form: signed</option>
              <option value="unsigned">form: unsigned</option>
            </select>
            <input
              type="date"
              value={since}
              onChange={(e) => setSince(e.target.value)}
              className="mono rounded-sm border border-border bg-background px-2 py-2 text-xs"
              title="Added on or after"
            />
            <button
              onClick={() => setShowNew(true)}
              className="rounded-sm bg-primary px-4 py-2 text-xs font-display uppercase tracking-wider text-primary-foreground"
            >+ New</button>
          </div>
          <div className="mono mt-3 text-[10px] uppercase tracking-widest text-muted-foreground">
            // {filtered.length} of {contacts?.length ?? 0} contacts
          </div>
        </div>

        {isLoading && <div className="text-muted-foreground">Loading…</div>}
        {!isLoading && filtered.length === 0 && (
          <div className="panel p-6 text-sm text-muted-foreground">
            No contacts match. New submissions from your public <Link to="/dashboard/intakes" className="text-primary underline">intake form</Link> land here automatically.
          </div>
        )}

        <div className="panel overflow-hidden">
          <table className="w-full text-sm">
            <thead className="mono text-[10px] uppercase tracking-widest text-muted-foreground">
              <tr className="border-b border-border">
                <th className="px-4 py-3 text-left">Name</th>
                <th className="px-4 py-3 text-left">Phone</th>
                <th className="px-4 py-3 text-left hidden md:table-cell">Email</th>
                <th className="px-4 py-3 text-left">Source</th>
                <th className="px-4 py-3 text-left">SMS</th>
                <th className="px-4 py-3 text-left hidden lg:table-cell">Form</th>
                <th className="px-4 py-3 text-left hidden lg:table-cell">Last activity</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => {
                const last = lastReviewByContact?.get(c.id);
                return (
                  <tr key={c.id} className="border-b border-border/50 hover:bg-accent/30">
                    <td className="px-4 py-3">
                      <div className="font-medium">{[c.first_name, c.last_name].filter(Boolean).join(" ") || "Unnamed"}</div>
                      {c.last_service_date && (
                        <div className="mono text-[10px] text-muted-foreground">last job {fmtDate(c.last_service_date)}</div>
                      )}
                    </td>
                    <td className="px-4 py-3 mono text-xs">{c.phone_number}</td>
                    <td className="px-4 py-3 mono text-xs hidden md:table-cell">
                      <div>{c.email || "—"}</div>
                      {emailUpdateByContact?.get(c.id) && (
                        <div
                          className="mono text-[10px] text-violet"
                          title={`Was: ${emailUpdateByContact.get(c.id)!.old ?? "—"} → Now: ${emailUpdateByContact.get(c.id)!.new ?? "—"}`}
                        >
                          ⚠ email updated via quote, {fmtDate(emailUpdateByContact.get(c.id)!.at)}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3">{sourceBadge(c.source)}</td>
                    <td className="px-4 py-3">
                      {c.opt_in_consent ? (
                        <div>
                          <span className="mono text-[10px] uppercase tracking-wider text-moss">opted in</span>
                          <div className="mono text-[10px] text-muted-foreground">{fmtDate(c.sms_opt_in_at)}</div>
                        </div>
                      ) : (
                        <span className="mono text-[10px] uppercase tracking-wider text-muted-foreground">no consent</span>
                      )}
                    </td>
                    <td className="px-4 py-3 hidden lg:table-cell">
                      {c.consent_form_signed ? (
                        <div>
                          <span className="mono text-[10px] uppercase tracking-wider text-moss">signed</span>
                          <div className="mono text-[10px] text-muted-foreground">{fmtDate(c.consent_form_signed_at)}</div>
                        </div>
                      ) : (
                        <span className="mono text-[10px] uppercase tracking-wider text-muted-foreground">unsigned</span>
                      )}
                    </td>
                    <td className="px-4 py-3 hidden lg:table-cell mono text-[10px] text-muted-foreground">
                      {last ? `review ${last.status} · ${fmtDate(last.at)}` : "—"}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button onClick={() => setEditing(c)} className="mono text-[10px] uppercase tracking-wider text-primary hover:underline">edit</button>
                      <button
                        onClick={() => confirm(`Delete ${c.first_name || "contact"}?`) && del.mutate(c.id)}
                        className="mono text-[10px] uppercase tracking-wider text-destructive hover:underline ml-3"
                      >del</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {(showNew || editing) && (
        <ContactModal
          contact={editing}
          onClose={() => { setShowNew(false); setEditing(null); }}
          onSaved={() => { qc.invalidateQueries({ queryKey: ["contacts"] }); setShowNew(false); setEditing(null); }}
        />
      )}
    </div>
  );
}

function ContactModal({
  contact,
  onClose,
  onSaved,
}: {
  contact: Contact | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = !!contact;
  const [firstName, setFirstName] = useState(contact?.first_name || "");
  const [lastName, setLastName] = useState(contact?.last_name || "");
  const [phone, setPhone] = useState(contact?.phone_number || "");
  const [email, setEmail] = useState(contact?.email || "");
  const [notes, setNotes] = useState(contact?.notes || "");
  const [smsConsent, setSmsConsent] = useState(contact?.opt_in_consent ?? false);
  const [formSigned, setFormSigned] = useState(contact?.consent_form_signed ?? false);

  const save = useMutation({
    mutationFn: async () => {
      const validPhone = phoneSchema.parse(phone);
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) throw new Error("Not signed in");
      const payload = {
        user_id: u.user.id,
        first_name: firstName.trim(),
        last_name: lastName.trim() || null,
        phone_number: validPhone,
        email: email.trim() || null,
        notes: notes.trim() || null,
        opt_in_consent: smsConsent,
        consent_form_signed: formSigned,
      };
      if (isEdit) {
        const { error } = await supabase.from("customers").update(payload).eq("id", contact!.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("customers").insert({ ...payload, source: "manual" });
        if (error) throw error;
      }
    },
    onSuccess: () => {
      toast.success(isEdit ? "Contact updated" : "Contact added");
      onSaved();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="panel w-full max-w-lg p-5" onClick={(e) => e.stopPropagation()}>
        <div className="label-eyebrow">{isEdit ? "Edit contact" : "New contact"}</div>
        <h2 className="mt-1 text-xl">{isEdit ? [firstName, lastName].filter(Boolean).join(" ") || "Contact" : "Add manually"}</h2>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <input value={firstName} onChange={(e) => setFirstName(e.target.value)} placeholder="First name" className="mono rounded-sm border border-border bg-background px-3 py-2 text-sm" />
          <input value={lastName} onChange={(e) => setLastName(e.target.value)} placeholder="Last name" className="mono rounded-sm border border-border bg-background px-3 py-2 text-sm" />
          <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+15551234567" className="mono rounded-sm border border-border bg-background px-3 py-2 text-sm sm:col-span-2" />
          <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email@example.com" className="mono rounded-sm border border-border bg-background px-3 py-2 text-sm sm:col-span-2" />
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes" rows={3} className="mono rounded-sm border border-border bg-background px-3 py-2 text-sm sm:col-span-2" />
        </div>

        <div className="mt-4 space-y-2 text-xs">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={smsConsent} onChange={(e) => setSmsConsent(e.target.checked)} className="h-4 w-4 accent-primary" />
            Customer has opted in to SMS
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={formSigned} onChange={(e) => setFormSigned(e.target.checked)} className="h-4 w-4 accent-primary" />
            Signed consent form on file
          </label>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-sm border border-border px-4 py-2 text-xs uppercase tracking-wider">Cancel</button>
          <button
            disabled={!phone || save.isPending}
            onClick={() => save.mutate()}
            className="rounded-sm bg-primary px-4 py-2 text-xs uppercase tracking-wider text-primary-foreground disabled:opacity-50"
          >
            {save.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
