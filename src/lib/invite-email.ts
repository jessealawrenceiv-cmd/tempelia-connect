/**
 * Single source of truth for the staff-invite email content, so the preview
 * modal and the copyable instructions never drift apart.
 *
 * Invites are claimed by matching the staff member's own confirmed email —
 * there is no secret token in the URL, so the email is instructions, not a
 * magic link.
 */

export const INVITE_WINDOW_DAYS = 7;

export type InviteEmailInput = {
  invitedEmail: string;
  businessName: string;
  origin: string;
  /** ISO expiry. Omit for a not-yet-created invite (assumes a fresh 7-day window). */
  expiresAt?: string | null;
};

export type InviteEmail = {
  to: string;
  from: string;
  subject: string;
  body: string;
  expiresAt: string;
  authUrl: string;
  acceptUrl: string;
};

export const SUPPORT_EMAIL = "admin@temaro.io";

export function projectedExpiry(from = new Date()): string {
  return new Date(from.getTime() + INVITE_WINDOW_DAYS * 86_400_000).toISOString();
}

export function formatExpiry(iso: string): string {
  return new Date(iso).toLocaleString([], {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function daysUntil(iso: string): number {
  return Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000));
}

export function buildInviteEmail(input: InviteEmailInput): InviteEmail {
  const business = input.businessName.trim() || "our business";
  const expiresAt = input.expiresAt ?? projectedExpiry();
  const authUrl = `${input.origin}/auth`;
  const acceptUrl = `${input.origin}/accept-invite`;

  const body = [
    `You've been invited to help run the ${business} account on Temaro.`,
    ``,
    `How to get access:`,
    `1. Go to ${authUrl} and sign up (or sign in) using this exact email address: ${input.invitedEmail}`,
    `2. Confirm your email from your inbox.`,
    `3. You'll be routed to ${acceptUrl} to activate staff access.`,
    ``,
    `Important: the invite is matched to ${input.invitedEmail}. Signing in with any other address will not find it.`,
    ``,
    `This invite expires ${formatExpiry(expiresAt)} (${INVITE_WINDOW_DAYS}-day window). If it lapses, ask the account owner to resend it.`,
    ``,
    `Questions? Reply here or contact ${SUPPORT_EMAIL}.`,
  ].join("\n");

  return {
    to: input.invitedEmail,
    from: SUPPORT_EMAIL,
    subject: `You're invited to the ${business} account on Temaro`,
    body,
    expiresAt,
    authUrl,
    acceptUrl,
  };
}
