import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader } from "@/components/AppShell";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/dashboard/quotes/new")({
  component: NewQuotePage,
});

// ─── Category catalog ────────────────────────────────────────────
const SURFACE_PREP_OPTIONS = [
  "Removal",
  "Remove and Grind",
  "Shot Blast",
  "Grind",
  "Light Grind (prep for coating or epoxy)",
  "Heavy Grind (level or multiple passes)",
] as const;

const DESIRED_FINISH_OPTIONS = [
  "Light Grind (prep for coating or epoxy)",
  "Heavy Grind (level or multiple passes)",
  "Matte-Satin",
  "Polished Shine",
  "High-Gloss Showroom Finish",
  "Epoxy — Decorative Flake",
  "Epoxy — Metallic",
  "Epoxy — Solid Color (Durable/Garage)",
  "Sealing",
  "Coating Removal Only",
  "Shot-Blasted Finish",
] as const;

type CategoryKey =
  | "surface_prep"
  | "crack_repair"
  | "desired_finish"
  | "densifier"
  | "edge_work"
  | "fuel_transport"
  | "tooling"
  | "other";

type CategoryState = {
  key: CategoryKey;
  label: string;
  checked: boolean;
  amount: string;   // dollar amount as string for input
  variant?: string; // for dropdown categories, chosen sub-label
  freeLabel?: string; // for "other"
};

const INITIAL_CATEGORIES: CategoryState[] = [
  { key: "surface_prep",   label: "Surface Prep",              checked: false, amount: "", variant: SURFACE_PREP_OPTIONS[0] },
  { key: "crack_repair",   label: "Crack Repair",              checked: false, amount: "" },
  { key: "desired_finish", label: "Desired Finish",            checked: false, amount: "", variant: DESIRED_FINISH_OPTIONS[0] },
  { key: "densifier",      label: "Densifier & Stain Guard",   checked: false, amount: "" },
  { key: "edge_work",      label: "Edge Work (hand grinding)", checked: false, amount: "" },
  { key: "fuel_transport", label: "Fuel & Transportation",     checked: false, amount: "" },
  { key: "tooling",        label: "Tooling",                   checked: false, amount: "" },
  { key: "other",          label: "Other",                     checked: false, amount: "", freeLabel: "" },
];

type LaborMode = "flat" | "percent";

// Strict numeric validator. Accepts only clean decimal strings like
// "0", "12", "12.5", "12.50", ".5". Rejects "", "-1", "12abc", "1e6",
// "1,000", "  12", "NaN", "Infinity", etc. Blank returns { blank: true }
// so callers can distinguish "empty" from "garbage".
type AmountParse =
  | { ok: true; value: number }
  | { ok: false; blank: boolean };

function parseAmount(raw: string): AmountParse {
  const s = (raw ?? "").trim();
  if (s === "") return { ok: false, blank: true };
  if (!/^\d+(\.\d+)?$|^\.\d+$/.test(s)) return { ok: false, blank: false };
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return { ok: false, blank: false };
  return { ok: true, value: n };
}
function amountErr(raw: string, requirePositive = false): string | null {
  const p = parseAmount(raw);
  if (!p.ok) return p.blank ? "Enter an amount" : "Numbers only (e.g. 500 or 500.00)";
  if (requirePositive && p.value <= 0) return "Must be greater than 0";
  return null;
}
function toNum(s: string): number {
  const p = parseAmount(s);
  return p.ok ? p.value : 0;
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function money(n: number) {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function NewQuotePage() {
  const navigate = useNavigate();

  // Customer
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [businessName, setBusinessName] = useState("");
  const [phone, setPhone] = useState("");
  const [poNumber, setPoNumber] = useState("");
  const [jobSite, setJobSite] = useState("");
  const [billing, setBilling] = useState("");
  const [description, setDescription] = useState("");

  // Line items
  const [categories, setCategories] = useState<CategoryState[]>(INITIAL_CATEGORIES);

  // Labor (separate — depends on other checked items when in percent mode)
  const [laborChecked, setLaborChecked] = useState(false);
  const [laborMode, setLaborMode] = useState<LaborMode>("flat");
  const [laborInput, setLaborInput] = useState(""); // dollars or percent

  // Tax / job
  const [jobType, setJobType] = useState<"existing_building" | "new_construction">("existing_building");
  const [taxExempt, setTaxExempt] = useState(false);
  const [taxRateInput, setTaxRateInput] = useState("9.5");
  const [validUntil, setValidUntil] = useState<string>("");

  // ─── VALIDATION ────────────────────────────────────────────────
  // Per-row inline errors for every checked category (incl. Other) and
  // for the Labor input (flat $ or %). Blank vs garbage both flagged.
  const rowErrors = useMemo(
    () => categories.map((c) => (c.checked ? amountErr(c.amount, true) : null)),
    [categories],
  );
  const laborError = laborChecked ? amountErr(laborInput, true) : null;
  const hasInvalidInput =
    rowErrors.some((e) => e !== null) || laborError !== null;

  // ─── LIVE MATH ─────────────────────────────────────────────────
  const nonLaborSubtotal = useMemo(() => {
    return categories
      .filter((c) => c.checked)
      .reduce((sum, c) => sum + toNum(c.amount), 0);
  }, [categories]);

  const laborAmount = useMemo(() => {
    if (!laborChecked) return 0;
    if (laborMode === "flat") return toNum(laborInput);
    // percent of non-labor checked items
    return round2(nonLaborSubtotal * (toNum(laborInput) / 100));
  }, [laborChecked, laborMode, laborInput, nonLaborSubtotal]);

  const subtotal = round2(nonLaborSubtotal + laborAmount);

  // Tax applies unless: new construction OR manual tax-exempt override.
  const taxable = jobType === "existing_building" && !taxExempt;
  const taxRateParse = parseAmount(taxRateInput);
  const taxRate = taxable && taxRateParse.ok ? taxRateParse.value : 0;
  const taxAmount = round2(subtotal * (taxRate / 100));
  const total = round2(subtotal + taxAmount);

  // "Send" requires at least one checked line item with a positive amount
  // (Labor alone counts). Draft can be saved without this.
  const hasAnyValidLine =
    categories.some((c, i) => c.checked && rowErrors[i] === null && toNum(c.amount) > 0) ||
    (laborChecked && laborError === null && laborAmount > 0);

  function updateCategory(idx: number, patch: Partial<CategoryState>) {
    setCategories((prev) => prev.map((c, i) => (i === idx ? { ...c, ...patch } : c)));
  }

  const save = useMutation({
    mutationFn: async (status: "draft" | "sent") => {
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) throw new Error("Not signed in");
      if (!firstName.trim()) throw new Error("First name required");
      if (!phone.trim()) throw new Error("Phone required");
      if (!jobSite.trim()) throw new Error("Job site address required");
      // Never persist garbage — blocks BOTH draft and sent.
      if (hasInvalidInput) {
        throw new Error("Fix the highlighted amount fields before saving");
      }
      // Completeness — only blocks "sent"; drafts may be incomplete.
      if (status === "sent" && !hasAnyValidLine) {
        throw new Error("Add at least one line item with an amount greater than $0 before sending");
      }

      // Build line_items array from checked categories (+ labor)
      const line_items: Array<Record<string, string | number>> = [];
      for (const c of categories) {
        if (!c.checked) continue;
        let label = c.label;
        if (c.key === "surface_prep" || c.key === "desired_finish") label = c.variant || c.label;
        if (c.key === "other") label = (c.freeLabel || "").trim() || "Other";
        line_items.push({ key: c.key, label, amount: round2(toNum(c.amount)) });
      }
      if (laborChecked) {
        line_items.push({
          key: "labor",
          label: laborMode === "percent" ? `Labor (${toNum(laborInput)}%)` : "Labor",
          amount: laborAmount,
          labor_mode: laborMode,
          labor_input: toNum(laborInput),
        });
      }

      const { data, error } = await supabase
        .from("quotes")
        .insert({
          user_id: u.user.id,
          customer_first_name: firstName.trim(),
          customer_last_name: lastName.trim() || null,
          customer_business_name: businessName.trim() || null,
          customer_phone: phone.trim(),
          po_number: poNumber.trim() || null,
          job_site_address: jobSite.trim(),
          billing_address: billing.trim() || null,
          description: description.trim() || null,
          line_items,
          subtotal,
          tax_rate: taxRate,
          tax_amount: taxAmount,
          total_amount: total,
          job_type: jobType,
          tax_exempt: taxExempt,
          valid_until: validUntil || null,
          status,
        })
        .select("id")
        .single();
      if (error) throw error;
      return data.id as string;
    },
    onSuccess: () => {
      toast.success("Quote saved");
      navigate({ to: "/dashboard/quotes" });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div>
      <PageHeader eyebrow="Estimates" title="Create Quote" />
      <div className="p-5 md:p-8 space-y-5 max-w-5xl">
        {/* Customer */}
        <section className="panel p-5 space-y-3">
          <div className="label-eyebrow">Customer</div>
          <div className="grid gap-3 sm:grid-cols-2">
            <input value={firstName} onChange={(e) => setFirstName(e.target.value)} placeholder="First name *" className="mono rounded-sm border border-border bg-background px-3 py-2 text-sm" />
            <input value={lastName} onChange={(e) => setLastName(e.target.value)} placeholder="Last name" className="mono rounded-sm border border-border bg-background px-3 py-2 text-sm" />
            <input value={businessName} onChange={(e) => setBusinessName(e.target.value)} placeholder="Business name (optional)" className="mono rounded-sm border border-border bg-background px-3 py-2 text-sm sm:col-span-2" />
            <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Phone *" className="mono rounded-sm border border-border bg-background px-3 py-2 text-sm" />
            <input value={poNumber} onChange={(e) => setPoNumber(e.target.value)} placeholder="PO # (optional)" className="mono rounded-sm border border-border bg-background px-3 py-2 text-sm" />
            <input value={jobSite} onChange={(e) => setJobSite(e.target.value)} placeholder="Job site address *" className="mono rounded-sm border border-border bg-background px-3 py-2 text-sm sm:col-span-2" />
            <input value={billing} onChange={(e) => setBilling(e.target.value)} placeholder="Billing address (if different)" className="mono rounded-sm border border-border bg-background px-3 py-2 text-sm sm:col-span-2" />
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Description / scope notes" rows={3} className="mono rounded-sm border border-border bg-background px-3 py-2 text-sm sm:col-span-2" />
          </div>
        </section>

        {/* Line items */}
        <section className="panel p-5 space-y-3">
          <div className="label-eyebrow">Line items</div>
          <div className="mono text-[10px] uppercase tracking-widest text-muted-foreground">
            // check what applies · enter each amount manually
          </div>

          <div className="divide-y divide-border">
            {categories.map((c, idx) => (
              <div key={c.key} className="grid grid-cols-[auto_1fr_auto] items-start gap-3 py-3">
                <input
                  type="checkbox"
                  checked={c.checked}
                  onChange={(e) => updateCategory(idx, { checked: e.target.checked })}
                  className="mt-2 h-4 w-4 accent-primary"
                />
                <div className="min-w-0 space-y-2">
                  <div className="text-sm font-medium">{c.label}</div>
                  {c.key === "surface_prep" && (
                    <select
                      value={c.variant}
                      onChange={(e) => updateCategory(idx, { variant: e.target.value })}
                      disabled={!c.checked}
                      className="mono w-full rounded-sm border border-border bg-background px-2 py-1.5 text-xs disabled:opacity-50"
                    >
                      {SURFACE_PREP_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
                    </select>
                  )}
                  {c.key === "desired_finish" && (
                    <select
                      value={c.variant}
                      onChange={(e) => updateCategory(idx, { variant: e.target.value })}
                      disabled={!c.checked}
                      className="mono w-full rounded-sm border border-border bg-background px-2 py-1.5 text-xs disabled:opacity-50"
                    >
                      {DESIRED_FINISH_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
                    </select>
                  )}
                  {c.key === "other" && (
                    <input
                      value={c.freeLabel || ""}
                      onChange={(e) => updateCategory(idx, { freeLabel: e.target.value })}
                      disabled={!c.checked}
                      placeholder="Label (e.g. Concrete overlay)"
                      className="mono w-full rounded-sm border border-border bg-background px-2 py-1.5 text-xs disabled:opacity-50"
                    />
                  )}
                </div>
                <div className="flex flex-col items-end gap-1">
                  <div className="flex items-center gap-1">
                    <span className="mono text-xs text-muted-foreground">$</span>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={c.amount}
                      onChange={(e) => updateCategory(idx, { amount: e.target.value })}
                      disabled={!c.checked}
                      placeholder="0.00"
                      aria-invalid={rowErrors[idx] !== null}
                      className={`mono w-28 rounded-sm border bg-background px-2 py-1.5 text-sm text-right disabled:opacity-50 ${
                        rowErrors[idx] ? "border-destructive" : "border-border"
                      }`}
                    />
                  </div>
                  {rowErrors[idx] && (
                    <span className="mono text-[10px] text-destructive">{rowErrors[idx]}</span>
                  )}
                </div>
              </div>
            ))}

            {/* Labor row */}
            <div className="grid grid-cols-[auto_1fr_auto] items-start gap-3 py-3">
              <input
                type="checkbox"
                checked={laborChecked}
                onChange={(e) => setLaborChecked(e.target.checked)}
                className="mt-2 h-4 w-4 accent-primary"
              />
              <div className="min-w-0 space-y-2">
                <div className="text-sm font-medium">Labor</div>
                <div className="flex items-center gap-2">
                  <select
                    value={laborMode}
                    onChange={(e) => setLaborMode(e.target.value as LaborMode)}
                    disabled={!laborChecked}
                    className="mono rounded-sm border border-border bg-background px-2 py-1.5 text-xs disabled:opacity-50"
                  >
                    <option value="flat">Flat $</option>
                    <option value="percent">% of other checked items</option>
                  </select>
                  {laborMode === "percent" && laborChecked && !laborError && (
                    <span className="mono text-[10px] text-muted-foreground">
                      = {money(laborAmount)} of {money(nonLaborSubtotal)}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex flex-col items-end gap-1">
                <div className="flex items-center gap-1">
                  <span className="mono text-xs text-muted-foreground">{laborMode === "flat" ? "$" : ""}</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={laborInput}
                    onChange={(e) => setLaborInput(e.target.value)}
                    disabled={!laborChecked}
                    placeholder={laborMode === "flat" ? "0.00" : "0"}
                    aria-invalid={laborError !== null}
                    className={`mono w-28 rounded-sm border bg-background px-2 py-1.5 text-sm text-right disabled:opacity-50 ${
                      laborError ? "border-destructive" : "border-border"
                    }`}
                  />
                  <span className="mono text-xs text-muted-foreground">{laborMode === "percent" ? "%" : ""}</span>
                </div>
                {laborError && (
                  <span className="mono text-[10px] text-destructive">{laborError}</span>
                )}
              </div>
            </div>

          </div>
        </section>

        {/* Tax + totals */}
        <section className="panel p-5 space-y-4">
          <div className="label-eyebrow">Tax</div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <div className="mono text-[10px] uppercase tracking-widest text-muted-foreground">Job type</div>
              <div className="flex overflow-hidden rounded-sm border border-border">
                <button
                  type="button"
                  onClick={() => setJobType("existing_building")}
                  className={`flex-1 px-3 py-2 text-xs uppercase tracking-wider ${jobType === "existing_building" ? "bg-primary text-primary-foreground" : "bg-background"}`}
                >Existing building (taxable)</button>
                <button
                  type="button"
                  onClick={() => setJobType("new_construction")}
                  className={`flex-1 px-3 py-2 text-xs uppercase tracking-wider ${jobType === "new_construction" ? "bg-primary text-primary-foreground" : "bg-background"}`}
                >New construction (not taxed)</button>
              </div>
              <div className="mono text-[10px] text-muted-foreground">
                Arkansas: flooring on new construction isn't taxed; on existing buildings it is.
              </div>
            </div>

            <div className="space-y-2">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={taxExempt} onChange={(e) => setTaxExempt(e.target.checked)} className="h-4 w-4 accent-primary" />
                Tax exempt (manual override)
              </label>
              <div className="flex items-center gap-2">
                <span className="mono text-xs text-muted-foreground">Tax rate</span>
                <input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="0.001"
                  value={taxRateInput}
                  onChange={(e) => setTaxRateInput(e.target.value)}
                  disabled={!taxable}
                  className="mono w-24 rounded-sm border border-border bg-background px-2 py-1.5 text-sm text-right disabled:opacity-50"
                />
                <span className="mono text-xs text-muted-foreground">%</span>
                {!taxable && (
                  <span className="mono text-[10px] text-orange">
                    {jobType === "new_construction" ? "not taxed (new construction)" : "not taxed (exempt)"}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <span className="mono text-xs text-muted-foreground">Valid until</span>
                <input type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} className="mono rounded-sm border border-border bg-background px-2 py-1.5 text-sm" />
              </div>
            </div>
          </div>

          <div className="border-t border-border pt-4">
            <div className="ml-auto max-w-xs space-y-1.5 mono text-sm">
              <div className="flex justify-between"><span className="text-muted-foreground">Subtotal</span><span>{money(subtotal)}</span></div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Tax ({taxable ? `${taxRate}%` : "0%"})</span>
                <span>{money(taxAmount)}</span>
              </div>
              <div className="flex justify-between border-t border-border pt-1.5 text-base font-display uppercase tracking-wider">
                <span>Total</span><span>{money(total)}</span>
              </div>
            </div>
          </div>
        </section>

        <div className="flex justify-end gap-2">
          <button
            onClick={() => navigate({ to: "/dashboard/quotes" })}
            className="rounded-sm border border-border px-4 py-2 text-xs uppercase tracking-wider"
          >Cancel</button>
          <button
            disabled={save.isPending}
            onClick={() => save.mutate("draft")}
            className="rounded-sm border border-border px-4 py-2 text-xs uppercase tracking-wider disabled:opacity-50"
          >Save as draft</button>
          <button
            disabled={save.isPending}
            onClick={() => save.mutate("sent")}
            className="rounded-sm bg-primary px-4 py-2 text-xs uppercase tracking-wider text-primary-foreground disabled:opacity-50"
          >Save & mark sent</button>
        </div>
      </div>
    </div>
  );
}
