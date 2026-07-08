# Tempelia — Build Plan

Multi-tenant SaaS with a lot of moving parts (Supabase, Stripe, Twilio, cron, webhooks). I'll build it in staged phases so you get a working, testable app at each step instead of one giant unverifiable drop.

## Phase 1 — Foundation (this turn)
- Enable Lovable Cloud (Supabase: Postgres + Auth + RLS).
- Design system in `src/styles.css`: charcoal `#1F2421`, paper `#F6F3EC`, safety-orange `#E2572B`, steel-blue `#3B5A6B`, moss-green `#4C7A5C`. Fonts: Barlow Condensed (display), Inter (body), IBM Plex Mono (numbers/log). Industrial/utility feel — sharp corners, thin rules, dispatch-log styling.
- DB migration: `users` (profile linked to `auth.users`), `integrations`, `customers`, `logs` — all with RLS scoped to `auth.uid()`, GRANTs, and a `handle_new_user` trigger.
- Auth: email/password signup with business name + ToS checkbox, login, protected `_authenticated` layout.
- Dashboard shell + routes: Overview, Missed Calls, Reviews, Dead Leads, Settings, Onboarding. Mobile-first, scales to desktop admin.
- Overview cards + dispatch-log activity feed reading from `logs`.
- Reviews screen: pick/add customer → "Mark complete" → insert log (SMS wiring comes in Phase 3).
- Dead Leads screen: query customers with `last_service_date < now() - 6 months` and no reactivation log in last 30 days.

At the end of Phase 1 the app is fully usable end-to-end with mock/no SMS — you can sign up, onboard, add customers, mark jobs complete, and see logs. Nothing texts out yet.

## Phase 2 — Stripe billing
- Recommend + enable Lovable's built-in Stripe Payments.
- Three products: Starter $99, Standard $199, Premium $299 (monthly, 30-day trial, card required).
- Checkout on signup, customer portal link in Settings, webhook updates `subscription_status` / `subscription_tier`.

## Phase 3 — Twilio (SMS + missed-call webhook)
- Onboarding form stores Twilio SID / auth token / phone number in `integrations` (encrypted at rest via pgsodium or a `vault`-style pattern; token never returned to client after save).
- Server function `sendSms` — checks `opt_in_consent`, appends "Reply STOP to unsubscribe.", logs to `logs`.
- Public route `/api/public/twilio/voice` — TwiML that rings the business, on no-answer/voicemail fires missed-call auto-text within 30s, creates customer if new (consent=false → flagged "needs consent" until they reply).
- Public route `/api/public/twilio/sms` — inbound handler for STOP/START (flips `opt_in_consent`) and first-reply consent capture on missed-call flow.
- "Send now" buttons on Reviews and Dead Leads call `sendSms`.

## Phase 4 — Scheduled reactivation
- pg_cron daily job hits `/api/public/cron/reactivate` (shared-secret header), scans stale customers, sends reactivation SMS via same `sendSms` path.

## Compliance (enforced from Phase 1 schema, active from Phase 3)
- Every SMS ends with "Reply STOP to unsubscribe."
- No send unless `opt_in_consent = true`; otherwise row appears in a "needs consent" list.
- ToS checkbox required on signup, timestamp stored.
- No review gating — same message to every customer.

## Technical notes
- Stack: TanStack Start (already scaffolded), Supabase via Lovable Cloud, `createServerFn` for all app-internal writes, TSS server routes under `/api/public/*` for Twilio/Stripe webhooks and cron.
- RLS on every table: `user_id = auth.uid()`. Webhooks use service-role admin client, loaded inside handler after signature/secret verification.
- Secrets: `TWILIO_ACCOUNT_SID` etc. per-tenant live in `integrations` (server reads them via service role after auth check); Stripe/webhook signing secrets via `add_secret`.

## What I need from you before Phase 3
- Confirm you want Lovable's built-in Stripe Payments (no Stripe account setup needed) vs. bring-your-own Stripe keys.
- For Twilio: each tenant brings their own Twilio number/credentials via Onboarding (per your spec) — confirm.

Reply "go" to start Phase 1, or tell me what to change.