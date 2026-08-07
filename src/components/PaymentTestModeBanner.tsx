import { useRouterState } from "@tanstack/react-router";

const clientToken = import.meta.env.VITE_PAYMENTS_CLIENT_TOKEN;

/**
 * Public documents (invoices, quotes) collect no payment at all, so any
 * payments-environment notice there is misleading. Suppress it on those paths.
 */
const HIDDEN_PATH_PREFIXES = ["/invoice/", "/quote/"];

export function PaymentTestModeBanner() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  if (HIDDEN_PATH_PREFIXES.some((p) => pathname.startsWith(p))) return null;


  if (!clientToken) {
    return (
      <div className="w-full border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-center text-sm text-destructive">
        Production checkout is not configured. Complete payments go-live in your Lovable project to accept real payments.
      </div>
    );
  }
  if (clientToken.startsWith("pk_test_")) {
    return (
      <div className="w-full border-b border-orange/30 bg-orange/10 px-4 py-2 text-center text-sm text-foreground">
        Payments are in test mode. No real money is charged.
      </div>
    );
  }
  return null;
}
