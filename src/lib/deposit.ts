// Deposit math — mirrors public.resolve_deposit_amount() in the database.
// Keep both in sync: the DB trigger rejects any deposit_amount that doesn't
// match the selected preset within a 1-cent tolerance.

export type DepositSelection =
  | "none"
  | "company_default"
  | "percent_10"
  | "percent_25"
  | "percent_50"
  | "custom"
  | "full";

export type DepositCustomType = "percentage" | "fixed";

export type CompanyDefaultDepositType =
  | "none"
  | "percent_10"
  | "percent_25"
  | "percent_50"
  | "fixed"
  | "full";

export const DEPOSIT_SELECTIONS: Array<{ value: DepositSelection; label: string }> = [
  { value: "none", label: "None" },
  { value: "company_default", label: "Use company default" },
  { value: "percent_10", label: "10%" },
  { value: "percent_25", label: "25%" },
  { value: "percent_50", label: "50%" },
  { value: "custom", label: "Custom amount" },
  { value: "full", label: "Full payment" },
];

export const COMPANY_DEFAULT_TYPES: Array<{ value: CompanyDefaultDepositType; label: string }> = [
  { value: "none", label: "No deposit" },
  { value: "percent_10", label: "10% of total" },
  { value: "percent_25", label: "25% of total" },
  { value: "percent_50", label: "50% of total" },
  { value: "fixed", label: "Fixed dollar amount" },
  { value: "full", label: "Full payment up front" },
];

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function describeCompanyDefault(
  type: CompanyDefaultDepositType | null | undefined,
  fixed: number | null | undefined,
): string {
  switch (type ?? "none") {
    case "percent_10": return "10%";
    case "percent_25": return "25%";
    case "percent_50": return "50%";
    case "full": return "Full payment";
    case "fixed": return fixed != null ? `$${round2(Number(fixed)).toFixed(2)} fixed` : "$0.00 fixed";
    default: return "No deposit";
  }
}

export function resolveCompanyDefaultAmount(
  type: CompanyDefaultDepositType | null | undefined,
  fixed: number | null | undefined,
  total: number,
): number {
  const t = Number.isFinite(total) ? total : 0;
  switch (type ?? "none") {
    case "percent_10": return round2(t * 0.1);
    case "percent_25": return round2(t * 0.25);
    case "percent_50": return round2(t * 0.5);
    case "full": return round2(t);
    case "fixed": return round2(Number(fixed ?? 0));
    default: return 0;
  }
}

export function resolveDepositAmount(args: {
  selection: DepositSelection;
  customType?: DepositCustomType | null;
  customValue?: number | null;
  total: number;
  defaultType?: CompanyDefaultDepositType | null;
  defaultFixed?: number | null;
}): number {
  const t = Number.isFinite(args.total) ? args.total : 0;
  switch (args.selection) {
    case "none": return 0;
    case "percent_10": return round2(t * 0.1);
    case "percent_25": return round2(t * 0.25);
    case "percent_50": return round2(t * 0.5);
    case "full": return round2(t);
    case "custom":
      if (args.customType === "percentage") return round2(t * (Number(args.customValue ?? 0) / 100));
      return round2(Number(args.customValue ?? 0));
    case "company_default":
      return resolveCompanyDefaultAmount(args.defaultType, args.defaultFixed, t);
    default: return 0;
  }
}

export function depositSelectionLabel(
  selection: DepositSelection,
  customType?: DepositCustomType | null,
  customValue?: number | null,
): string {
  if (selection === "custom") {
    return customType === "percentage"
      ? `Custom ${Number(customValue ?? 0)}%`
      : `Custom $${round2(Number(customValue ?? 0)).toFixed(2)}`;
  }
  return DEPOSIT_SELECTIONS.find((s) => s.value === selection)?.label ?? "None";
}
