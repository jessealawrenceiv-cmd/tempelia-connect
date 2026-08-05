import {
  asConnectStatus,
  describeConnectStatus,
  formatFeePercent,
  isPaymentsAvailable,
  type ConnectProfileFields,
} from "@/lib/online-payments";

/**
 * Settings shell for online deposit collection. Deliberately shows an honest
 * "not yet available" state — no dead buttons — until Stripe Connect is
 * approved for the platform and there's a real key to build/test against.
 */
export function OnlinePaymentsPanel({
  stripe_connect_account_id,
  stripe_connect_status,
  platform_fee_percent,
  stripe_connect_connected_at,
}: ConnectProfileFields) {
  const status = asConnectStatus(stripe_connect_status);
  const { label, detail } = describeConnectStatus(status);
  const available = isPaymentsAvailable(status);

  return (
    <div className="panel p-6 md:col-span-2">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="label-eyebrow">Payments</div>
          <h2 className="mt-1 text-xl">Accept online payments</h2>
        </div>
        <span
          className={`mono rounded-sm border px-2 py-1 text-[10px] uppercase tracking-widest ${
            available
              ? "border-primary/40 text-primary"
              : "border-border text-muted-foreground"
          }`}
        >
          {label}
        </span>
      </div>

      <p className="mt-3 text-xs text-muted-foreground">{detail}</p>

      {!available && (
        <div className="mt-4 rounded-sm border border-border bg-muted/20 p-4">
          <p className="mono text-[10px] uppercase tracking-widest text-muted-foreground">
            Coming soon
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            Customers will be able to pay their deposit from the quote link, with funds
            paid out to your own bank account. We're waiting on Stripe Connect approval
            before switching this on — we won't ship a payment flow we can't test end to
            end. Until then, mark deposits received manually on the quote.
          </p>
          <button
            type="button"
            disabled
            aria-disabled="true"
            title="Available once Stripe Connect approval completes"
            className="mono mt-4 cursor-not-allowed rounded-sm border border-border px-3 py-2 text-[11px] uppercase tracking-widest text-muted-foreground opacity-60"
          >
            Connect with Stripe · unavailable
          </button>
        </div>
      )}

      <dl className="mt-5 grid gap-4 sm:grid-cols-3">
        <div>
          <dt className="label-eyebrow">Payout account</dt>
          <dd className="mono mt-1 text-xs">
            {stripe_connect_account_id ?? "—"}
          </dd>
        </div>
        <div>
          <dt className="label-eyebrow">Platform fee</dt>
          <dd className="mono mt-1 text-xs">{formatFeePercent(platform_fee_percent)}</dd>
        </div>
        <div>
          <dt className="label-eyebrow">Connected</dt>
          <dd className="mono mt-1 text-xs">
            {stripe_connect_connected_at
              ? new Date(stripe_connect_connected_at).toLocaleString()
              : "—"}
          </dd>
        </div>
      </dl>
    </div>
  );
}
