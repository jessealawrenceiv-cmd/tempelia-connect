import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/terms")({
  head: () => ({
    meta: [
      { title: "Terms of Service — Temaro" },
      { name: "description", content: "Temaro's terms of service for business customers using our communication automation platform." },
      { property: "og:title", content: "Terms of Service — Temaro" },
      { property: "og:description", content: "Terms of service for Temaro business customers." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: TermsPage,
});

const CONTACT_EMAIL = "admin@temaro.io";

function TermsPage() {
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
        <h1 className="mt-2 text-4xl md:text-5xl">Terms of Service</h1>
        <p className="mono mt-4 text-sm text-muted-foreground">Last updated: August 3, 2026</p>

        <div className="mt-10 space-y-10">
          <section>
            <p className="text-base leading-relaxed text-foreground/90">
              By signing up for Temaro, you agree to these terms.
            </p>
          </section>

          <section>
            <h2 className="text-2xl">The Service</h2>
            <p className="mt-4 text-base leading-relaxed text-foreground/90">
              Temaro provides communication automation software — including missed-call auto-texting, review requests, dead-lead reactivation, project intake forms, quotes, and appointment scheduling — for local service businesses. You are responsible for ensuring your own customers have properly consented to receive automated text messages, and for the accuracy of information you enter into the platform.
            </p>
          </section>

          <section>
            <h2 className="text-2xl">Subscription and Billing</h2>
            <p className="mt-4 text-base leading-relaxed text-foreground/90">
              Temaro offers a 30-day free trial. A valid payment method is required at signup. After the trial period, your subscription bills automatically each month at the rate for your selected tier (Starter or Standard) until canceled. You can manage or cancel your subscription at any time through your account settings.
            </p>
          </section>

          <section>
            <h2 className="text-2xl">Cancellation</h2>
            <p className="mt-4 text-base leading-relaxed text-foreground/90">
              When you cancel, automated actions (texts, calls) stop immediately. Your data remains accessible for 30 days in case you reactivate. Your dedicated phone number is released 14 days after cancellation if you have not reactivated. You can export your customer and quote data at any time, including during cancellation.
            </p>
          </section>

          <section>
            <h2 className="text-2xl">Acceptable Use</h2>
            <p className="mt-4 text-base leading-relaxed text-foreground/90">
              You may not use Temaro to send messages to anyone who has not consented to receive them, to send unlawful, harassing, or misleading content, or to use the service in any way that violates telecommunications regulations (including TCPA requirements). We reserve the right to suspend accounts that violate these terms.
            </p>
          </section>

          <section>
            <h2 className="text-2xl">Third-Party Services</h2>
            <p className="mt-4 text-base leading-relaxed text-foreground/90">
              Temaro relies on third-party providers including Twilio (messaging/calling), Stripe (payments), and Supabase (data storage) to operate. Your use of Temaro is also subject to the acceptable use policies of these providers.
            </p>
          </section>

          <section>
            <h2 className="text-2xl">Limitation of Liability</h2>
            <p className="mt-4 text-base leading-relaxed text-foreground/90">
              Temaro is provided "as is." We are not liable for indirect, incidental, or consequential damages arising from your use of the service, to the maximum extent permitted by law.
            </p>
          </section>

          <section>
            <h2 className="text-2xl">Changes to These Terms</h2>
            <p className="mt-4 text-base leading-relaxed text-foreground/90">
              We may update these terms from time to time. Continued use of Temaro after changes constitutes acceptance of the updated terms.
            </p>
          </section>

          <section>
            <h2 className="text-2xl">Contact</h2>
            <p className="mt-4 text-base leading-relaxed text-foreground/90">
              Questions about these terms can be sent to{" "}
              <a href={`mailto:${CONTACT_EMAIL}`} className="text-orange hover:underline">
                {CONTACT_EMAIL}
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
