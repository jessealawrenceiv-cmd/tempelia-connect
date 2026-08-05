/**
 * Single source of truth for the outbound quote SMS body. Both the real send
 * (sendQuoteSms) and the "Deposit SMS preview" (previewQuoteSms) call this, so
 * what the owner previews is byte-for-byte what the customer receives.
 */
import { depositCustomerLine } from "./deposit";

export type QuoteSmsBodyArgs = {
  firstName: string | null | undefined;
  businessName: string;
  quoteId: string;
  validUntil: string | null | undefined;
  total: number | string | null | undefined;
  depositRequired: boolean | null | undefined;
  depositAmount: number | string | null | undefined;
  /** Public site origin used for the quote link. */
  publicBase: string;
  /** Compliance footer appended to every outbound message. */
  stopSuffix: string;
};

export function buildQuoteSmsBody(args: QuoteSmsBodyArgs): {
  message: string;
  link: string;
  depositLine: string | null;
} {
  const link = `${args.publicBase}/quote/${args.quoteId}`;
  const validLine = args.validUntil
    ? ` Valid until ${new Date(args.validUntil).toLocaleDateString("en-US")}.`
    : "";
  const depositLine = depositCustomerLine({
    depositRequired: args.depositRequired,
    depositAmount: args.depositAmount,
    total: args.total,
  });
  const depositSuffix = depositLine ? ` ${depositLine}` : "";
  const message = `Hi ${args.firstName || "there"}, here's your quote from ${args.businessName}: ${link}.${validLine}${depositSuffix}${args.stopSuffix}`;
  return { message, link, depositLine };
}

/** GSM-7 vs UCS-2 aware segment count, for the preview character counter. */
export function smsSegmentCount(message: string): { chars: number; segments: number; unicode: boolean } {
  const unicode = /[^\u0000-\u007F]/.test(message);
  const chars = message.length;
  const limit = unicode ? 70 : 160;
  const multi = unicode ? 67 : 153;
  const segments = chars <= limit ? 1 : Math.ceil(chars / multi);
  return { chars, segments, unicode };
}
