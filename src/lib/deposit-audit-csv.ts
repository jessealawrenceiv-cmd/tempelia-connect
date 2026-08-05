/**
 * CSV export for the deposit audit trail. Rows come straight from the existing
 * public.logs entries written by markQuoteDeposit — no separate tracking.
 */

export type DepositAuditCsvRow = {
  created_at: string;
  status: string;
  quote_id: string;
  quote_short_id: string;
  customer_name: string;
  actor_email: string;
  actor_user_id: string;
  actor_is_owner: string;
  deposit_amount: string;
  total_amount: string;
  balance_remaining: string;
  previous_paid: string;
  previous_paid_at: string;
  new_paid: string;
  new_paid_at: string;
};

const HEADERS = [
  "logged_at_utc",
  "action",
  "quote_id",
  "quote_short_id",
  "customer_name",
  "actor_email",
  "actor_user_id",
  "actor_is_owner",
  "deposit_amount",
  "quote_total",
  "balance_remaining",
  "previous_paid",
  "previous_paid_at",
  "new_paid",
  "new_paid_at",
];

function escapeCell(value: string): string {
  const safe = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function buildDepositAuditCsv(rows: DepositAuditCsvRow[]): string {
  const lines = [HEADERS.join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.created_at,
        r.status,
        r.quote_id,
        r.quote_short_id,
        r.customer_name,
        r.actor_email,
        r.actor_user_id,
        r.actor_is_owner,
        r.deposit_amount,
        r.total_amount,
        r.balance_remaining,
        r.previous_paid,
        r.previous_paid_at,
        r.new_paid,
        r.new_paid_at,
      ]
        .map((c) => escapeCell(c ?? ""))
        .join(","),
    );
  }
  return lines.join("\r\n");
}
