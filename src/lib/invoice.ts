/**
 * Invoice math + display helpers. Mirrors the database:
 *  - public.invoices.balance_due is a generated column:
 *    round(total_amount - (deposit_paid ? deposit_amount : 0), 2)
 *  - public.invoices_validate_totals() enforces
 *    total_amount = sum(line_items.amount) + tax_amount (1-cent tolerance)
 * Keep this file in sync with those triggers.
 */

export type InvoiceStatus = "draft" | "sent" | "paid" | "archived";

export type InvoiceLineItem = { label?: string; amount?: number | string };

export const INVOICE_STATUS_LABEL: Record<InvoiceStatus, string> = {
  draft: "Draft — not yet sent",
  sent: "Sent — awaiting payment",
  paid: "Paid in full",
  archived: "Replaced by a newer invoice",
};

export function round2(n: number): number {
  return Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;
}

export function toNum(v: number | string | null | undefined): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export function fmtMoney(n: number | string | null | undefined): string {
  return toNum(n).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

/** Same formula as the generated balance_due column. */
export function invoiceBalanceDue(args: {
  total: number | string | null | undefined;
  depositAmount: number | string | null | undefined;
  depositPaid: boolean | null | undefined;
}): number {
  return round2(toNum(args.total) - (args.depositPaid ? toNum(args.depositAmount) : 0));
}

/** Line-item sum + tax, matching invoices_validate_totals(). */
export function invoiceTotals(items: InvoiceLineItem[], taxRate: number | string | null | undefined) {
  const subtotal = round2(items.reduce((s, it) => s + toNum(it.amount), 0));
  const rate = toNum(taxRate);
  const taxAmount = round2(subtotal * (rate / 100));
  return { subtotal, taxRate: rate, taxAmount, total: round2(subtotal + taxAmount) };
}

/** Customer-facing credit line for a deposit already received. */
export function depositCreditedLine(args: {
  depositAmount: number | string | null | undefined;
  depositPaid: boolean | null | undefined;
}): string | null {
  const amount = toNum(args.depositAmount);
  if (!args.depositPaid || amount <= 0) return null;
  return `Deposit of ${fmtMoney(amount)} already received — thank you.`;
}

/** Language must match the Payments settings copy: tracking-only, no collection. */
export function contactToPayLine(businessName: string | null | undefined): string {
  return `Contact ${businessName || "the business"} directly to pay this balance.`;
}
