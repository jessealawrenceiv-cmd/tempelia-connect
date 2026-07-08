import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: Landing,
});

const features = [
  {
    tag: "01 · Missed-Call Auto-Text",
    title: "Catch the call you couldn't answer.",
    body: "Within 30 seconds of a missed call to your business line, Tempelia texts the caller from the same number. No lead left hanging.",
  },
  {
    tag: "02 · Review Booster",
    title: "Turn every finished job into a review.",
    body: "Mark a job complete on the dashboard — we text the customer a Google review link. Same message every time. No review gating.",
  },
  {
    tag: "03 · Dead-Lead Re-Activator",
    title: "Wake up your dormant customer list.",
    body: "Any customer 6+ months out gets a friendly seasonal check-in text. Runs daily on autopilot — override or send manually anytime.",
  },
];

const tiers = [
  { name: "Starter", price: "99", blurb: "Solo operator. 1 phone line." },
  { name: "Standard", price: "199", blurb: "Small crew. 2 lines, priority support.", featured: true },
  { name: "Premium", price: "299", blurb: "Multi-location. 5 lines, custom flows." },
];

function Landing() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border bg-charcoal text-paper">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4">
          <Link to="/" className="flex items-center gap-2">
            <span className="grid h-8 w-8 shrink-0 place-items-center bg-orange text-orange-foreground font-display text-lg font-bold">T</span>
            <span className="font-display text-xl font-bold uppercase tracking-wider">Tempelia</span>
          </Link>
          <div className="flex items-center gap-3">
            <Link to="/auth" className="text-sm uppercase tracking-wider text-paper/80 hover:text-paper">Sign in</Link>
            <Link
              to="/auth"
              search={{ mode: "signup" }}
              className="rounded-sm bg-orange px-4 py-2 text-sm font-medium uppercase tracking-wider text-orange-foreground hover:opacity-90"
            >
              Start trial
            </Link>
          </div>
        </div>
      </header>

      <section className="border-b border-border">
        <div className="mx-auto grid max-w-6xl gap-10 px-4 py-16 md:grid-cols-[1.3fr_1fr] md:py-24">
          <div>
            <div className="label-eyebrow">Dispatch · Local service ops</div>
            <h1 className="mt-4 text-5xl leading-[0.95] md:text-7xl">
              The comms channel<br />
              your service business<br />
              <span className="text-orange">doesn't miss.</span>
            </h1>
            <p className="mt-6 max-w-lg text-base text-muted-foreground">
              Tempelia auto-texts every missed call, requests reviews after every job, and
              re-activates dead leads on schedule — for plumbers, HVAC, salons and contractors.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link
                to="/auth"
                search={{ mode: "signup" }}
                className="rounded-sm bg-orange px-5 py-3 text-sm font-medium uppercase tracking-wider text-orange-foreground hover:opacity-90"
              >
                Start 30-day trial
              </Link>
              <Link
                to="/auth"
                className="rounded-sm border border-border bg-card px-5 py-3 text-sm font-medium uppercase tracking-wider text-foreground hover:bg-accent"
              >
                Sign in
              </Link>
            </div>
            <div className="mono mt-6 text-xs text-muted-foreground">
              Card required · Cancel anytime · SMS opt-out on every message
            </div>
          </div>

          <div className="panel p-5">
            <div className="label-eyebrow flex items-center justify-between">
              <span>Dispatch log · live</span>
              <span className="flex items-center gap-1.5">
                <span className="h-2 w-2 animate-pulse rounded-full bg-moss" />
                <span className="text-moss">ONLINE</span>
              </span>
            </div>
            <ul className="mono mt-4 space-y-2 text-xs">
              {[
                ["08:41:22", "moss", "MISSED_CALL_TEXT → +1•555•0142 · 'sorry we missed you'"],
                ["09:03:07", "steel", "REVIEW_REQUEST → Jordan · google review link sent"],
                ["09:15:44", "orange", "MISSED_CALL_TEXT → +1•555•0198 · new customer created"],
                ["09:47:12", "moss", "REVIEW_REQUEST → Priya · delivered"],
                ["10:02:55", "steel", "REACTIVATION_TEXT → Marcus · 7 mo dormant"],
                ["10:18:31", "moss", "MISSED_CALL_TEXT → +1•555•0117 · delivered"],
              ].map(([t, c, msg]) => (
                <li key={t} className="grid grid-cols-[auto_auto_1fr] items-start gap-2">
                  <span className="text-muted-foreground">{t}</span>
                  <span className={`mt-1 h-2 w-2 shrink-0 rounded-full bg-${c}`} />
                  <span className="text-foreground/90">{msg}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <section className="border-b border-border">
        <div className="mx-auto max-w-6xl px-4 py-16">
          <div className="label-eyebrow">Three tools, one subscription</div>
          <h2 className="mt-2 text-3xl md:text-4xl">The bundle</h2>
          <div className="mt-8 grid gap-4 md:grid-cols-3">
            {features.map((f) => (
              <div key={f.tag} className="panel flex flex-col gap-3 p-6">
                <div className="mono text-xs text-orange">{f.tag}</div>
                <h3 className="text-2xl leading-tight">{f.title}</h3>
                <p className="text-sm text-muted-foreground">{f.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="border-b border-border">
        <div className="mx-auto max-w-6xl px-4 py-16">
          <div className="label-eyebrow">Pricing</div>
          <h2 className="mt-2 text-3xl md:text-4xl">Pick a tier. 30 days free.</h2>
          <div className="mt-8 grid gap-4 md:grid-cols-3">
            {tiers.map((t) => (
              <div
                key={t.name}
                className={`panel flex flex-col gap-3 p-6 ${t.featured ? "border-orange ring-1 ring-orange" : ""}`}
              >
                <div className="label-eyebrow">{t.name}</div>
                <div className="flex items-baseline gap-1">
                  <span className="stat-num">${t.price}</span>
                  <span className="mono text-xs text-muted-foreground">/mo</span>
                </div>
                <p className="text-sm text-muted-foreground">{t.blurb}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <footer className="bg-charcoal text-paper/70">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-6 text-xs uppercase tracking-wider">
          <span>© {new Date().getFullYear()} Tempelia</span>
          <span className="mono">Dispatch · Ops · Comms</span>
        </div>
      </footer>
    </div>
  );
}
