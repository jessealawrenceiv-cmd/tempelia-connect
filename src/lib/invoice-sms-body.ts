/**
 * Single source of truth for the outbound invoice SMS body — same shape and
 * discipline as buildQuoteSmsBody in ./quote-sms-body, so the real send and any
 * preview stay byte-for-byte identical.
 */
import { fmtMoney, invoiceBalanceDue } from "./invoice";

export type InvoiceSmsBodyArgs = {
  firstName: string | null | undefined;
  businessName: string;
  invoiceId: string;
  invoiceNumber: string;
  total: number | string | null | undefined;
  depositAmount: number | string | null | undefined;
  depositPaid: boolean | null | undefined;
  /** Public site origin used for the invoice link. */
  publicBase: string;
  /** Compliance footer appended to every outbound message. */
  stopSuffix: string;
};

export function buildInvoiceSmsBody(args: InvoiceSmsBodyArgs): {
  message: string;
  link: string;
  balanceDue: number;
  depositLine: string | null;
} {
  const link = `${args.publicBase}/invoice/${args.invoiceId}`;
  const balanceDue = invoiceBalanceDue({
    total: args.total,
    depositAmount: args.depositAmount,
    depositPaid: args.depositPaid,
  });
  const depositLine =
    args.depositPaid && Number(args.depositAmount ?? 0) > 0
      ? `Deposit of ${fmtMoney(args.depositAmount)} already credited.`
      : null;
  const depositSuffix = depositLine ? ` ${depositLine}` : "";
  const message = `Hi ${args.firstName || "there"}, here's invoice ${args.invoiceNumber} from ${args.businessName}: ${link}. Balance due ${fmtMoney(balanceDue)}.${depositSuffix}${args.stopSuffix}`;
  return { message, link, balanceDue, depositLine };
}
