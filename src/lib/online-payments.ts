/**
 * Online payment (Stripe Connect) data model helpers.
 *
 * Tracking/shell only for now: onboarding, destination charges and webhooks are
 * intentionally NOT implemented until the platform Connect application is
 * approved and a real platform secret key exists to build & test against.
 */

export const CONNECT_STATUSES = [
  "not_available",
  "not_connected",
  "pending",
  "connected",
  "disabled",
] as const;

export type ConnectStatus = (typeof CONNECT_STATUSES)[number];

export type ConnectProfileFields = {
  stripe_connect_account_id?: string | null;
  stripe_connect_status?: string | null;
  platform_fee_percent?: number | null;
  stripe_connect_connected_at?: string | null;
};

export function asConnectStatus(value?: string | null): ConnectStatus {
  return (CONNECT_STATUSES as readonly string[]).includes(value ?? "")
    ? (value as ConnectStatus)
    : "not_available";
}

export function describeConnectStatus(status: ConnectStatus): {
  label: string;
  detail: string;
} {
  switch (status) {
    case "not_connected":
      return {
        label: "Not connected",
        detail: "Online payments are available but no payout account is linked yet.",
      };
    case "pending":
      return {
        label: "Pending review",
        detail: "Stripe is still verifying this account. Payouts start once verified.",
      };
    case "connected":
      return {
        label: "Connected",
        detail: "Deposits can be collected online and paid out to this account.",
      };
    case "disabled":
      return {
        label: "Disabled",
        detail: "Stripe disabled this account. Contact support@stripe.com to restore payouts.",
      };
    default:
      return {
        label: "Not yet available",
        detail:
          "Online deposit collection is pending our Stripe Connect platform approval. Deposits stay tracking-only until then.",
      };
  }
}

export function isPaymentsAvailable(status: ConnectStatus): boolean {
  return status !== "not_available";
}

export function formatFeePercent(percent?: number | null): string {
  const n = typeof percent === "number" ? percent : 0;
  return `${n.toFixed(2).replace(/\.00$/, "")}%`;
}
