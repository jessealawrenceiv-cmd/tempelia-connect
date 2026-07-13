import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CalendarDays, Download, ChevronLeft, ChevronRight } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader } from "@/components/AppShell";
import { downloadIcs } from "@/lib/ics";

type ScheduleSearch = {
  customerId?: string;
  quoteId?: string;
  intakeId?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  title?: string;
  address?: string;
};

export const Route = createFileRoute("/_authenticated/dashboard/schedule")({
  component: SchedulePage,
  validateSearch: (s: Record<string, unknown>): ScheduleSearch => ({
    customerId: typeof s.customerId === "string" ? s.customerId : undefined,
    quoteId: typeof s.quoteId === "string" ? s.quoteId : undefined,
    intakeId: typeof s.intakeId === "string" ? s.intakeId : undefined,
    firstName: typeof s.firstName === "string" ? s.firstName : undefined,
    lastName: typeof s.lastName === "string" ? s.lastName : undefined,
    phone: typeof s.phone === "string" ? s.phone : undefined,
    title: typeof s.title === "string" ? s.title : undefined,
    address: typeof s.address === "string" ? s.address : undefined,
  }),
});

type Appointment = {
  id: string;
  user_id: string;
  customer_id: string | null;
  quote_id: string | null;
  intake_submission_id: string | null;
  title: string;
  date: string;
  time: string | null;
  duration_minutes: number;
  notes: string | null;
  created_at: string;
};

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// duration in minutes: 0 => all-day; otherwise timed length
const DURATION_PRESETS: Array<{ label: string; value: number }> = [
  { label: "30m", value: 30 },
  { label: "1h", value: 60 },
  { label: "2h", value: 120 },
  { label: "4h", value: 240 },
  { label: "All day", value: 0 },
];

function addMinutesHHMM(hhmm: string, minutes: number): string {
  const [h, m] = hhmm.split(":").map(Number);
  const total = h * 60 + m + minutes;
  const wrapped = ((total % (24 * 60)) + 24 * 60) % (24 * 60);
  return `${String(Math.floor(wrapped / 60)).padStart(2, "0")}:${String(wrapped % 60).padStart(2, "0")}`;
}

function SchedulePage() {
  const qc = useQueryClient();
  const search = Route.useSearch();
  const navigate = useNavigate();

  const [viewMonth, setViewMonth] = useState(() => {
    const t = new Date();
    return new Date(t.getFullYear(), t.getMonth(), 1);
  });

  const [highlightId, setHighlightId] = useState<string | null>(null);
  const listRefs = useRef<Record<string, HTMLDivElement | null>>({});

  // Form state (prefilled from search params)
  const [firstName, setFirstName] = useState(search.firstName ?? "");
  const [lastName, setLastName] = useState(search.lastName ?? "");
  const [phone, setPhone] = useState(search.phone ?? "");
  const [title, setTitle] = useState(search.title ?? "");
  const [date, setDate] = useState<string>(ymd(new Date()));
  const [time, setTime] = useState<string>("09:00");
  const [durationMinutes, setDurationMinutes] = useState<number>(60);
  const [customDuration, setCustomDuration] = useState<string>("");
  const isCustomDuration = !DURATION_PRESETS.some((p) => p.value === durationMinutes);
  const isAllDay = durationMinutes === 0;
  const [notes, setNotes] = useState<string>(search.address ? `Location: ${search.address}` : "");
  const [customerId, setCustomerId] = useState<string | null>(search.customerId ?? null);
  const quoteIdParam = search.quoteId ?? null;
  const intakeIdParam = search.intakeId ?? null;

  // If arriving with a customerId, mark contact as matched
  const [contactNote, setContactNote] = useState<string>("");

  // Suggest contacts by first-name or phone match
  const { data: contactSuggestions } = useQuery({
    queryKey: ["contact-suggest", phone, firstName],
    queryFn: async () => {
      const q = phone.trim() || firstName.trim();
      if (!q) return [];
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) return [];
      const { data } = await supabase
        .from("customers")
        .select("id, first_name, last_name, phone_number")
        .eq("user_id", u.user.id)
        .or(`phone_number.ilike.%${q}%,first_name.ilike.%${q}%,last_name.ilike.%${q}%`)
        .limit(5);
      return data ?? [];
    },
    enabled: (phone.trim().length > 0 || firstName.trim().length > 0),
  });

  useEffect(() => {
    // If phone entered, try to lookup matching contact & prefill first/last
    async function lookup() {
      const p = phone.trim();
      if (!p) { setContactNote(""); return; }
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) return;
      const { data: c } = await supabase
        .from("customers")
        .select("id, first_name, last_name, phone_number")
        .eq("user_id", u.user.id)
        .eq("phone_number", p)
        .maybeSingle();
      if (c) {
        setContactNote(`// matched existing contact — ${c.first_name} ${c.last_name ?? ""}`.trimEnd());
      } else {
        setContactNote("// new contact — will be created on save");
      }
    }
    lookup();
  }, [phone]);

  // Appointments list
  const { data: appts } = useQuery({
    queryKey: ["appointments"],
    refetchOnWindowFocus: true,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("appointments")
        .select("*")
        .order("date", { ascending: true })
        .order("time", { ascending: true });
      if (error) throw error;
      return (data ?? []) as Appointment[];
    },
  });

  const create = useMutation({
    mutationFn: async () => {
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) throw new Error("Not signed in");
      if (!title.trim()) throw new Error("Title required");
      if (!date) throw new Error("Date required");

      // Upsert customer (same pattern as quotes.new) — dedupe on user_id + phone_number.
      let cid: string | null = customerId;
      const phoneTrim = phone.trim();
      if (phoneTrim && firstName.trim()) {
        const { data: cust, error: cerr } = await supabase
          .from("customers")
          .upsert(
            {
              user_id: u.user.id,
              first_name: firstName.trim(),
              last_name: lastName.trim() || null,
              phone_number: phoneTrim,
              source: "schedule",
            },
            { onConflict: "user_id,phone_number" },
          )
          .select("id")
          .single();
        if (cerr) throw cerr;
        cid = cust.id;
      }

      const allDay = durationMinutes === 0;
      const { data, error } = await supabase
        .from("appointments")
        .insert({
          user_id: u.user.id,
          customer_id: cid,
          quote_id: quoteIdParam,
          intake_submission_id: intakeIdParam,
          title: title.trim(),
          date,
          time: allDay ? null : (time || null),
          duration_minutes: durationMinutes,
          notes: notes.trim() || null,
        })
        .select("*")
        .single();
      if (error) throw error;
      return data as Appointment;
    },
    onSuccess: (row) => {
      toast.success("Appointment scheduled");
      qc.invalidateQueries({ queryKey: ["appointments"] });
      // Reset form to defaults
      setTitle("");
      setNotes("");
      setFirstName(""); setLastName(""); setPhone("");
      setCustomerId(null);
      // Clear prefill search params
      navigate({ to: "/dashboard/schedule", search: {}, replace: true });
      // Jump grid to that month & highlight the new row
      const [y, m] = row.date.split("-").map(Number);
      setViewMonth(new Date(y, m - 1, 1));
      setHighlightId(row.id);
      setTimeout(() => {
        listRefs.current[row.id]?.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 100);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // Group appointments by date (YYYY-MM-DD) for the visible month
  const monthKey = `${viewMonth.getFullYear()}-${String(viewMonth.getMonth() + 1).padStart(2, "0")}`;
  const byDate = useMemo(() => {
    const map: Record<string, Appointment[]> = {};
    (appts ?? []).forEach((a) => {
      (map[a.date] ??= []).push(a);
    });
    return map;
  }, [appts]);

  const monthAppts = useMemo(() => {
    return (appts ?? [])
      .filter((a) => a.date.startsWith(monthKey))
      .sort((a, b) => (a.date + (a.time ?? "")).localeCompare(b.date + (b.time ?? "")));
  }, [appts, monthKey]);

  // Build the 42-cell month grid
  const cells = useMemo(() => {
    const first = new Date(viewMonth);
    const startDow = first.getDay(); // 0 = Sunday
    const daysInMonth = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
    const prevMonthDays = new Date(first.getFullYear(), first.getMonth(), 0).getDate();
    const arr: Array<{ date: Date; inMonth: boolean; key: string }> = [];
    for (let i = startDow - 1; i >= 0; i--) {
      const d = new Date(first.getFullYear(), first.getMonth() - 1, prevMonthDays - i);
      arr.push({ date: d, inMonth: false, key: ymd(d) });
    }
    for (let day = 1; day <= daysInMonth; day++) {
      const d = new Date(first.getFullYear(), first.getMonth(), day);
      arr.push({ date: d, inMonth: true, key: ymd(d) });
    }
    while (arr.length < 42) {
      const last = arr[arr.length - 1].date;
      const d = new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1);
      arr.push({ date: d, inMonth: false, key: ymd(d) });
    }
    return arr;
  }, [viewMonth]);

  const todayKey = ymd(new Date());

  function handleDayClick(dateKey: string) {
    const first = byDate[dateKey]?.[0];
    if (!first) return;
    setHighlightId(first.id);
    listRefs.current[first.id]?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  const removeAppt = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("appointments").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Deleted");
      qc.invalidateQueries({ queryKey: ["appointments"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const monthLabel = viewMonth.toLocaleString("en-US", { month: "long", year: "numeric" });

  return (
    <div>
      <PageHeader eyebrow="Ops" title="Schedule" />
      <div className="p-5 md:p-8 space-y-6">
        {/* Calendar */}
        <div className="panel p-4">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <button
                onClick={() => setViewMonth(new Date(viewMonth.getFullYear(), viewMonth.getMonth() - 1, 1))}
                className="rounded-sm border border-border p-1.5 hover:border-primary hover:text-primary"
                aria-label="Previous month"
              ><ChevronLeft size={16} /></button>
              <button
                onClick={() => setViewMonth(new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 1))}
                className="rounded-sm border border-border p-1.5 hover:border-primary hover:text-primary"
                aria-label="Next month"
              ><ChevronRight size={16} /></button>
              <button
                onClick={() => {
                  const t = new Date();
                  setViewMonth(new Date(t.getFullYear(), t.getMonth(), 1));
                }}
                className="mono rounded-sm border border-border px-3 py-1 text-[10px] uppercase tracking-widest hover:border-primary hover:text-primary"
              >Today</button>
            </div>
            <div className="font-display text-xl uppercase tracking-wider">{monthLabel}</div>
            <div className="w-24" />
          </div>

          <div className="mt-4 grid grid-cols-7 gap-px bg-border">
            {["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map((d) => (
              <div key={d} className="bg-background px-2 py-1 mono text-[10px] uppercase tracking-widest text-muted-foreground text-center">{d}</div>
            ))}
            {cells.map(({ date, inMonth, key }) => {
              const dayAppts = byDate[key] ?? [];
              const has = dayAppts.length > 0;
              const isToday = key === todayKey;
              return (
                <button
                  key={key + (inMonth ? "" : "-x")}
                  onClick={() => handleDayClick(key)}
                  disabled={!has}
                  className={`bg-background min-h-[70px] p-1.5 text-left transition-colors ${
                    inMonth ? "" : "opacity-40"
                  } ${has ? "hover:bg-primary/10 cursor-pointer" : "cursor-default"}`}
                  data-testid={`cal-day-${key}`}
                >
                  <div className={`mono text-xs ${isToday ? "text-primary font-bold" : "text-paper"}`}>
                    {date.getDate()}
                  </div>
                  {has && (
                    <div className="mt-1 space-y-0.5">
                      <div className="flex items-center gap-1">
                        <span className="inline-block h-1.5 w-1.5 rounded-full bg-primary" />
                        <span className="mono text-[9px] uppercase tracking-widest text-muted-foreground">{dayAppts.length}</span>
                      </div>
                      {dayAppts.slice(0, 2).map((a) => (
                        <div key={a.id} className="mono text-[9px] truncate text-paper/80" title={a.title}>
                          {a.time ? a.time.slice(0,5) + " " : ""}{a.title}
                        </div>
                      ))}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Add form */}
        <div className="panel p-5">
          <div className="label-eyebrow mb-3 flex items-center gap-2">
            <CalendarDays size={14} /> Add appointment
            {(quoteIdParam || intakeIdParam) && (
              <span className="mono text-[10px] text-primary">
                // linked to {quoteIdParam ? "quote " + quoteIdParam.slice(0,8) : "intake " + (intakeIdParam ?? "").slice(0,8)}
              </span>
            )}
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="block">
              <div className="mono text-[10px] uppercase tracking-widest text-muted-foreground">Title</div>
              <input value={title} onChange={(e) => setTitle(e.target.value)}
                placeholder="On-site estimate"
                className="mt-1 w-full rounded-sm border border-border bg-background px-3 py-2 text-sm" />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <div className="mono text-[10px] uppercase tracking-widest text-muted-foreground">Date</div>
                <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
                  className="mt-1 w-full rounded-sm border border-border bg-background px-3 py-2 text-sm mono" />
              </label>
              <label className="block">
                <div className="mono text-[10px] uppercase tracking-widest text-muted-foreground">Time</div>
                <input type="time" value={time} onChange={(e) => setTime(e.target.value)}
                  className="mt-1 w-full rounded-sm border border-border bg-background px-3 py-2 text-sm mono" />
              </label>
            </div>
            <label className="block">
              <div className="mono text-[10px] uppercase tracking-widest text-muted-foreground">First name</div>
              <input value={firstName} onChange={(e) => setFirstName(e.target.value)}
                className="mt-1 w-full rounded-sm border border-border bg-background px-3 py-2 text-sm" />
            </label>
            <label className="block">
              <div className="mono text-[10px] uppercase tracking-widest text-muted-foreground">Last name</div>
              <input value={lastName} onChange={(e) => setLastName(e.target.value)}
                className="mt-1 w-full rounded-sm border border-border bg-background px-3 py-2 text-sm" />
            </label>
            <label className="block md:col-span-2">
              <div className="mono text-[10px] uppercase tracking-widest text-muted-foreground">Phone</div>
              <input value={phone} onChange={(e) => setPhone(e.target.value)}
                placeholder="+15555550123"
                className="mt-1 w-full rounded-sm border border-border bg-background px-3 py-2 text-sm mono" />
              {contactNote && <div className="mt-1 mono text-[10px] text-muted-foreground">{contactNote}</div>}
              {(contactSuggestions?.length ?? 0) > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {contactSuggestions!.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => {
                        setFirstName(c.first_name);
                        setLastName(c.last_name ?? "");
                        setPhone(c.phone_number);
                        setCustomerId(c.id);
                      }}
                      className="mono rounded-sm border border-border px-2 py-0.5 text-[10px] hover:border-primary hover:text-primary"
                    >
                      {c.first_name} {c.last_name ?? ""} · {c.phone_number}
                    </button>
                  ))}
                </div>
              )}
            </label>
            <label className="block md:col-span-2">
              <div className="mono text-[10px] uppercase tracking-widest text-muted-foreground">Notes</div>
              <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3}
                className="mt-1 w-full rounded-sm border border-border bg-background px-3 py-2 text-sm" />
            </label>
          </div>
          <div className="mt-4 flex justify-end">
            <button
              disabled={create.isPending}
              onClick={() => create.mutate()}
              className="rounded-sm bg-primary px-4 py-2 text-xs font-display uppercase tracking-wider text-primary-foreground disabled:opacity-50"
            >
              {create.isPending ? "Scheduling…" : "Schedule appointment"}
            </button>
          </div>
        </div>

        {/* List for current month */}
        <div className="panel p-5">
          <div className="label-eyebrow mb-3">Appointments · {monthLabel}</div>
          {monthAppts.length === 0 && (
            <div className="text-sm text-muted-foreground">No appointments this month.</div>
          )}
          <div className="space-y-2">
            {monthAppts.map((a) => {
              const [y, m, d] = a.date.split("-").map(Number);
              const label = new Date(y, m - 1, d).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
              const isHi = highlightId === a.id;
              return (
                <div
                  key={a.id}
                  ref={(el) => { listRefs.current[a.id] = el; }}
                  data-testid={`appt-${a.id}`}
                  className={`rounded-sm border p-3 transition-colors ${isHi ? "border-primary bg-primary/10" : "border-border"}`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <div className="mono text-[10px] uppercase tracking-widest text-muted-foreground">
                        {label}{a.time ? ` · ${a.time.slice(0,5)}` : " · all-day"}
                      </div>
                      <div className="font-display text-base uppercase mt-0.5">{a.title}</div>
                      {a.notes && <div className="mono text-xs text-muted-foreground mt-1 whitespace-pre-wrap">{a.notes}</div>}
                      <div className="mono text-[10px] text-muted-foreground mt-1">
                        {a.quote_id && <>quote {a.quote_id.slice(0, 8)} · </>}
                        {a.intake_submission_id && <>intake {a.intake_submission_id.slice(0, 8)} · </>}
                        {a.customer_id && <>contact {a.customer_id.slice(0, 8)}</>}
                      </div>
                    </div>
                    <div className="flex gap-1">
                      <button
                        onClick={() => downloadIcs({
                          id: a.id, title: a.title, date: a.date, time: a.time, notes: a.notes, createdAt: a.created_at,
                        })}
                        className="mono inline-flex items-center gap-1 rounded-sm border border-border px-2 py-1 text-[10px] uppercase tracking-wider hover:border-primary hover:text-primary"
                      ><Download size={12} /> .ics</button>
                      <button
                        onClick={() => { if (confirm("Delete this appointment?")) removeAppt.mutate(a.id); }}
                        className="mono rounded-sm border border-border px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground hover:border-destructive hover:text-destructive"
                      >delete</button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
