import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { z } from "zod";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

const searchSchema = z.object({
  mode: z.enum(["signin", "signup"]).catch("signin").optional(),
});

export const Route = createFileRoute("/auth")({
  validateSearch: searchSchema,
  component: AuthPage,
  head: () => ({
    meta: [
      { title: "Sign in — Tempelia" },
      { name: "description", content: "Sign in to your Tempelia account." },
      { name: "robots", content: "noindex" },
    ],
  }),
});

const signupSchema = z.object({
  business_name: z.string().trim().min(1, "Business name is required").max(120),
  email: z.string().trim().email().max(255),
  password: z.string().min(8, "At least 8 characters").max(72),
  tos: z.literal(true, { errorMap: () => ({ message: "You must accept the terms" }) }),
});

const signinSchema = z.object({
  email: z.string().trim().email().max(255),
  password: z.string().min(1).max(72),
});

function AuthPage() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const [mode, setMode] = useState<"signin" | "signup">(search.mode === "signup" ? "signup" : "signin");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) navigate({ to: "/dashboard" });
    });
  }, [navigate]);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setLoading(true);
    try {
      if (mode === "signup") {
        const parsed = signupSchema.safeParse({
          business_name: fd.get("business_name"),
          email: fd.get("email"),
          password: fd.get("password"),
          tos: fd.get("tos") === "on" ? true : false,
        });
        if (!parsed.success) {
          toast.error(parsed.error.issues[0]?.message ?? "Check your inputs");
          return;
        }
        const { error } = await supabase.auth.signUp({
          email: parsed.data.email,
          password: parsed.data.password,
          options: {
            emailRedirectTo: window.location.origin + "/dashboard",
            data: {
              business_name: parsed.data.business_name,
              tos_accepted: true,
            },
          },
        });
        if (error) { toast.error(error.message); return; }
        toast.success("Account created. Welcome aboard.");
        navigate({ to: "/onboarding" });
      } else {
        const parsed = signinSchema.safeParse({
          email: fd.get("email"),
          password: fd.get("password"),
        });
        if (!parsed.success) { toast.error("Enter your email and password"); return; }
        const { error } = await supabase.auth.signInWithPassword(parsed.data);
        if (error) { toast.error(error.message); return; }
        navigate({ to: "/dashboard" });
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="border-b border-border bg-charcoal text-paper">
        <div className="mx-auto flex max-w-6xl items-center gap-2 px-4 py-4">
          <a href="/" className="flex items-center gap-2">
            <img src="/logo-icon.png" alt="" className="h-9 w-auto" />
            <span className="font-display text-xl font-bold uppercase tracking-wider">Tempelia</span>
          </a>
        </div>
      </div>

      <div className="mx-auto grid min-h-[calc(100vh-72px)] max-w-5xl place-items-center px-4 py-10">
        <div className="panel w-full max-w-md p-8">
          <div className="label-eyebrow">Access panel</div>
          <h1 className="mt-2 text-3xl">{mode === "signup" ? "Open an account" : "Sign in"}</h1>

          <div className="mono mt-4 grid grid-cols-2 border border-border text-xs uppercase tracking-wider">
            <button
              type="button"
              onClick={() => setMode("signin")}
              className={`py-2 ${mode === "signin" ? "bg-charcoal text-paper" : "bg-transparent"}`}
            >Sign in</button>
            <button
              type="button"
              onClick={() => setMode("signup")}
              className={`py-2 ${mode === "signup" ? "bg-charcoal text-paper" : "bg-transparent"}`}
            >Sign up</button>
          </div>

          <form onSubmit={handleSubmit} className="mt-6 space-y-4">
            {mode === "signup" && (
              <Field label="Business name" name="business_name" placeholder="Acme Plumbing" required />
            )}
            <Field label="Email" name="email" type="email" placeholder="you@business.com" required />
            <Field label="Password" name="password" type="password" placeholder={mode === "signup" ? "8+ characters" : "••••••••"} required minLength={mode === "signup" ? 8 : 1} />

            {mode === "signup" && (
              <label className="flex items-start gap-2 text-xs text-muted-foreground">
                <input type="checkbox" name="tos" required className="mt-0.5 h-4 w-4 accent-orange" />
                <span>
                  I confirm my customers have opted in to receive text messages and I accept the
                  Tempelia terms of service.
                </span>
              </label>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-sm bg-orange px-4 py-3 text-sm font-medium uppercase tracking-wider text-orange-foreground hover:opacity-90 disabled:opacity-50"
            >
              {loading ? "Working…" : mode === "signup" ? "Create account" : "Sign in"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

function Field({ label, ...props }: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="block">
      <span className="label-eyebrow">{label}</span>
      <input
        {...props}
        className="mono mt-1 block w-full rounded-sm border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-orange"
      />
    </label>
  );
}
