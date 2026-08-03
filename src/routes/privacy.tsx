import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/privacy")({
  head: () => ({
    meta: [
      { title: "Privacy Policy — Temaro" },
      { name: "description", content: "Temaro's privacy policy explains how we handle data for business customers and their end customers." },
      { property: "og:title", content: "Privacy Policy — Temaro" },
      { property: "og:description", content: "How Temaro handles data for businesses and their customers." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: PrivacyPage,
});

const SUPPORT_EMAIL = "admin@temaro.io";

function PrivacyPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border bg-charcoal text-paper">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4">
          <Link to="/" className="flex items-center gap-2">
            <img src="/logo-icon.png" alt="" className="h-9 w-auto" />
            <span className="font-display text-xl font-bold uppercase tracking-wider">Temaro</span>
          </Link>
          <Link to="/auth" className="text-sm uppercase tracking-wider text-paper/80 hover:text-paper">
            Sign in
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-12 md:py-20">
        <div className="label-eyebrow">Legal</div>
        <h1 className="mt-2 text-4xl md:text-5xl">Privacy Policy</h1>
        <p className="mono mt-4 text-sm text-muted-foreground">Last updated: August 3, 2026</p>

        <div className="mt-10 space-y-10">
          <section>
            <p className="text-base leading-relaxed text-foreground/90">
              Temaro ("we," "us") provides communication automation software to local service businesses. This policy covers how we handle information for both our business customers (the companies using Temaro) and their end customers (the people who call, text, or submit forms to those businesses).
            </p>
          </section>

          <section>
            <h2 className="text-2xl">Information We Collect</h2>
            <ul className="mt-4 list-disc space-y-2 pl-5 text-foreground/80">
              <li>From business customers: business name, contact information, billing details.</li>
              <li>
                From end customers (a business's own customers): name, phone number, email (if provided), project details and photos submitted through intake forms, quote and appointment history, and SMS consent status.
              </li>
              <li>If voicemail is enabled by a business, we store voicemail recordings tied to that missed call.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl">How We Use This Information</h2>
            <p className="mt-4 text-base leading-relaxed text-foreground/90">
              We use this information solely to operate the features a business has enabled: sending automated text replies to missed calls, requesting reviews after completed jobs, re-engaging past customers, sending and tracking quotes, and scheduling appointments. We do not sell this information to third parties.
            </p>
          </section>

          <section>
            <h2 className="text-2xl">SMS Consent and Opt-Out</h2>
            <p className="mt-4 text-base leading-relaxed text-foreground/90">
              Every automated text we send includes opt-out instructions. Replying STOP immediately and automatically stops all future messages to that number. Consent status is tracked and respected across every message type.
            </p>
          </section>

          <section>
            <h2 className="text-2xl">Third-Party Services</h2>
            <p className="mt-4 text-base leading-relaxed text-foreground/90">
              We use Twilio to send and receive text messages and calls, Stripe for payment processing, and Supabase for secure data storage. Each of these providers has its own privacy practices governing the data they process on our behalf.
            </p>
          </section>

          <section>
            <h2 className="text-2xl">Data Retention</h2>
            <p className="mt-4 text-base leading-relaxed text-foreground/90">
              If a business cancels their subscription, their data remains accessible for 30 days in case they reactivate, after which it is deleted. Records related to SMS consent may be retained longer to resolve any future disputes about opt-in status.
            </p>
          </section>

          <section>
            <h2 className="text-2xl">Your Rights</h2>
            <p className="mt-4 text-base leading-relaxed text-foreground/90">
              End customers who want their information removed, or businesses with questions about their data, can contact us at{" "}
              <a href={`mailto:${SUPPORT_EMAIL}`} className="text-orange hover:underline">
                {SUPPORT_EMAIL}
              </a>.
            </p>
          </section>

          <section>
            <h2 className="text-2xl">Contact</h2>
            <p className="mt-4 text-base leading-relaxed text-foreground/90">
              Questions about this policy can be sent to{" "}
              <a href={`mailto:${SUPPORT_EMAIL}`} className="text-orange hover:underline">
                {SUPPORT_EMAIL}
              </a>.
            </p>
          </section>
        </div>
      </main>

      <footer className="bg-charcoal text-paper/70">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-6 text-xs uppercase tracking-wider">
          <span>© {new Date().getFullYear()} Temaro</span>
          <div className="flex items-center gap-4">
            <Link to="/privacy" className="hover:text-paper">Privacy Policy</Link>
            <Link to="/terms" className="hover:text-paper">Terms of Service</Link>
            <span className="mono">Dispatch · Ops · Comms</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
