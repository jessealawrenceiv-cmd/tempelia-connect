import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { getIsAdmin } from "@/lib/admin.functions";
import {
  LayoutDashboard, PhoneMissed, Star, Snowflake, Settings, LogOut, Menu, X, Wrench, Shield, ClipboardList, Users, FileText,
} from "lucide-react";

const NAV = [
  { to: "/dashboard", label: "Overview", icon: LayoutDashboard },
  { to: "/dashboard/missed-calls", label: "Missed Calls", icon: PhoneMissed },
  { to: "/dashboard/contacts", label: "Contacts", icon: Users },
  { to: "/dashboard/quotes", label: "Quotes", icon: FileText },
  { to: "/dashboard/reviews", label: "Reviews", icon: Star },
  { to: "/dashboard/dead-leads", label: "Dead Leads", icon: Snowflake },
  { to: "/dashboard/intakes", label: "Intakes", icon: ClipboardList },
  { to: "/dashboard/settings", label: "Settings", icon: Settings },
] as const;

export function AppShell({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [businessName, setBusinessName] = useState<string>("");
  const [isAdmin, setIsAdmin] = useState(false);
  const getIsAdminFn = useServerFn(getIsAdmin);

  useEffect(() => { setOpen(false); }, [location.pathname]);

  useEffect(() => {
    (async () => {
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) return;
      const { data } = await supabase.from("profiles").select("business_name").eq("id", u.user.id).maybeSingle();
      setBusinessName(data?.business_name || u.user.email || "");
      try {
        const r = await getIsAdminFn();
        setIsAdmin(r.isAdmin);
      } catch {
        /* non-admin — hide the link */
      }
    })();
  }, [getIsAdminFn]);

  async function signOut() {
    await supabase.auth.signOut();
    navigate({ to: "/auth", replace: true });
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Top bar (mobile) */}
      <header className="sticky top-0 z-30 border-b border-border bg-charcoal text-paper md:hidden">
        <div className="flex items-center justify-between px-4 py-3">
          <div className="flex items-center gap-2">
            <img src="/logo-icon.png" alt="" className="h-7 w-auto" />
            <span className="font-display text-lg font-bold uppercase tracking-wider">Tempelia</span>
          </div>
          <button onClick={() => setOpen(!open)} aria-label="Menu" className="rounded-sm p-1.5 hover:bg-paper/10">
            {open ? <X size={20} /> : <Menu size={20} />}
          </button>
        </div>
      </header>

      <div className="md:flex">
        {/* Sidebar */}
        <aside
          className={`${open ? "block" : "hidden"} md:sticky md:top-0 md:block md:h-screen md:w-60 md:shrink-0`}
        >
          <div className="flex h-full flex-col border-r border-border bg-charcoal text-paper">
            <div className="hidden items-center gap-2 border-b border-paper/10 px-5 py-4 md:flex">
              <img src="/logo-icon.png" alt="" className="h-8 w-auto" />
              <span className="font-display text-xl font-bold uppercase tracking-wider">Tempelia</span>
            </div>

            <div className="px-5 py-3">
              <div className="mono text-[10px] uppercase tracking-widest text-paper/50">Business</div>
              <div className="mt-1 truncate font-display text-lg uppercase text-paper">{businessName || "—"}</div>
            </div>

            <nav className="flex-1 space-y-0.5 px-3">
              {NAV.map(({ to, label, icon: Icon }) => {
                const active = to === "/dashboard"
                  ? location.pathname === "/dashboard"
                  : location.pathname.startsWith(to);
                return (
                  <Link
                    key={to}
                    to={to}
                    className={`flex items-center gap-3 rounded-sm px-3 py-2 text-sm uppercase tracking-wider ${
                      active ? "bg-orange text-orange-foreground" : "text-paper/80 hover:bg-paper/10"
                    }`}
                  >
                    <Icon size={16} />
                    <span>{label}</span>
                  </Link>
                );
              })}
            </nav>

            <div className="border-t border-paper/10 p-3">
              {isAdmin && (
                <Link
                  to="/dashboard/admin/numbers"
                  className="mb-2 flex items-center gap-3 rounded-sm px-3 py-2 text-xs uppercase tracking-wider text-orange hover:bg-paper/10"
                >
                  <Shield size={14} /> Admin · Numbers
                </Link>
              )}
              <Link
                to="/onboarding"
                className="mb-2 flex items-center gap-3 rounded-sm px-3 py-2 text-xs uppercase tracking-wider text-paper/70 hover:bg-paper/10"
              >
                <Wrench size={14} /> Onboarding
              </Link>
              <button
                onClick={signOut}
                className="flex w-full items-center gap-3 rounded-sm px-3 py-2 text-xs uppercase tracking-wider text-paper/70 hover:bg-paper/10"
              >
                <LogOut size={14} /> Sign out
              </button>
            </div>
          </div>
        </aside>

        {/* Main */}
        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}

export function PageHeader({ eyebrow, title, actions }: { eyebrow: string; title: string; actions?: ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-4 border-b border-border bg-card px-5 py-6 md:px-8">
      <div className="min-w-0">
        <div className="label-eyebrow">{eyebrow}</div>
        <h1 className="mt-1 truncate text-3xl md:text-4xl">{title}</h1>
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}
