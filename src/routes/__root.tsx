import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";

import appCss from "../styles.css?url";
import { reportLovableError } from "../lib/lovable-error-reporting";
import { supabase } from "@/integrations/supabase/client";
import { Toaster } from "sonner";
import { PaymentTestModeBanner } from "@/components/PaymentTestModeBanner";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <div className="label-eyebrow">Error 404</div>
        <h1 className="mt-2 text-6xl text-foreground">Off the grid</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          That route isn't on the dispatch board.
        </p>
        <Link
          to="/"
          className="mt-6 inline-flex items-center justify-center rounded-sm bg-primary px-4 py-2 text-sm font-medium uppercase tracking-wider text-primary-foreground hover:opacity-90"
        >
          Return to base
        </Link>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  const router = useRouter();
  useEffect(() => {
    reportLovableError(error, { boundary: "tanstack_root_error_component" });
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <div className="label-eyebrow text-destructive">System fault</div>
        <h1 className="mt-2 text-3xl text-foreground">Signal lost</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          Something jammed on our end. Try again or head back to base.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => { router.invalidate(); reset(); }}
            className="rounded-sm bg-primary px-4 py-2 text-sm font-medium uppercase tracking-wider text-primary-foreground hover:opacity-90"
          >
            Retry
          </button>
          <a
            href="/"
            className="rounded-sm border border-border bg-card px-4 py-2 text-sm font-medium uppercase tracking-wider text-foreground hover:bg-accent"
          >
            Base
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Tempelia — Communication automation for local service pros" },
      { name: "description", content: "Missed-call auto-texts, review boosting, and dead-lead re-activation for plumbers, HVAC, salons and contractors." },
      { property: "og:title", content: "Tempelia — Communication automation for local service pros" },
      { property: "og:description", content: "Never miss a lead. Auto-text missed calls, boost Google reviews, and re-engage dormant customers." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", href: "/favicon.png", type: "image/png", sizes: "any" },
      { rel: "shortcut icon", href: "/favicon.png", type: "image/png" },
      { rel: "apple-touch-icon", href: "/logo-icon.png", sizes: "180x180" },
      { rel: "manifest", href: "/site.webmanifest" },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700;800&family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap",
      },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head><HeadContent /></head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();
  const router = useRouter();

  useEffect(() => {
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event !== "SIGNED_IN" && event !== "SIGNED_OUT" && event !== "USER_UPDATED") return;
      router.invalidate();
      if (event !== "SIGNED_OUT") queryClient.invalidateQueries();
    });
    return () => sub.subscription.unsubscribe();
  }, [router, queryClient]);

  return (
    <QueryClientProvider client={queryClient}>
      <PaymentTestModeBanner />
      <Outlet />
      <Toaster position="top-right" theme="dark" />
    </QueryClientProvider>
  );
}
