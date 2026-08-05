import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import {
  COMPANY_DEFAULT_TYPES,
  describeCompanyDefault,
  type CompanyDefaultDepositType,
} from "@/lib/deposit";

type Props = {
  defaultType?: string | null;
  defaultFixedAmount?: number | null;
  allowOverride?: boolean | null;
};

export function DepositDefaultsPanel({ defaultType, defaultFixedAmount, allowOverride }: Props) {
  const qc = useQueryClient();
  const [type, setType] = useState<CompanyDefaultDepositType>("none");
  const [fixed, setFixed] = useState("");
  const [override, setOverride] = useState(true);

  useEffect(() => {
    setType(((defaultType ?? "none") as CompanyDefaultDepositType));
    setFixed(defaultFixedAmount != null ? String(defaultFixedAmount) : "");
    setOverride(allowOverride ?? true);
  }, [defaultType, defaultFixedAmount, allowOverride]);

  const fixedError =
    type === "fixed" && !/^\d+(\.\d{1,2})?$|^\.\d{1,2}$/.test(fixed.trim())
      ? "Enter a dollar amount (e.g. 500 or 500.00)"
      : null;

  const save = useMutation({
    mutationFn: async () => {
      if (fixedError) throw new Error(fixedError);
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) throw new Error("Not signed in");
      const { error } = await supabase
        .from("profiles")
        .update({
          default_deposit_type: type,
          default_deposit_fixed_amount: type === "fixed" ? Number(fixed) : null,
          allow_deposit_override_per_quote: override,
        })
        .eq("id", u.user.id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Deposit defaults saved.");
      qc.invalidateQueries({ queryKey: ["profile"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="panel p-6">
      <div className="label-eyebrow">Deposits</div>
      <h2 className="mt-1 text-xl">Company deposit default</h2>
      <p className="mt-2 text-xs text-muted-foreground">
        Applied to new quotes that select “Use company default”. Tracking only — no payment is collected yet.
      </p>

      <div className="mt-4 space-y-4">
        <label className="block">
          <span className="label-eyebrow">Default deposit</span>
          <select
            value={type}
            onChange={(e) => setType(e.target.value as CompanyDefaultDepositType)}
            className="mono mt-1 block w-full rounded-sm border border-border bg-background px-3 py-2 text-sm"
          >
            {COMPANY_DEFAULT_TYPES.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        </label>

        {type === "fixed" && (
          <label className="block">
            <span className="label-eyebrow">Fixed amount ($)</span>
            <input
              value={fixed}
              inputMode="decimal"
              onChange={(e) => setFixed(e.target.value)}
              placeholder="500.00"
              className={`mono mt-1 block w-full rounded-sm border bg-background px-3 py-2 text-sm ${
                fixedError ? "border-destructive" : "border-border"
              }`}
            />
            {fixedError && <p className="mono mt-1 text-[10px] text-destructive">{fixedError}</p>}
          </label>
        )}

        <div className="flex items-center justify-between border-t border-border pt-4">
          <div>
            <div className="label-eyebrow">Allow per-quote override</div>
            <p className="mt-1 text-xs text-muted-foreground">
              When off, every quote is locked to the company default — no deposit options are shown on the quote form.
            </p>
          </div>
          <label className="mono flex cursor-pointer items-center gap-2 text-xs uppercase tracking-wider">
            <input
              type="checkbox"
              className="h-4 w-4 accent-primary"
              checked={override}
              onChange={(e) => setOverride(e.target.checked)}
            />
            {override ? "On" : "Off"}
          </label>
        </div>

        <div className="mono text-[10px] uppercase tracking-widest text-muted-foreground">
          // resolves to: {describeCompanyDefault(type, fixed ? Number(fixed) : null)}
        </div>

        <button
          onClick={() => save.mutate()}
          disabled={save.isPending || !!fixedError}
          className="w-full rounded-sm bg-orange px-4 py-3 text-sm font-medium uppercase tracking-wider text-orange-foreground hover:opacity-90 disabled:opacity-50"
        >
          {save.isPending ? "Saving…" : "Save deposit defaults"}
        </button>
      </div>
    </div>
  );
}
