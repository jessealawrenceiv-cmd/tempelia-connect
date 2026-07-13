import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getIntakeBusinessInfo, submitIntake } from "@/lib/intake.functions";
import { toast } from "sonner";

export const Route = createFileRoute("/intake/$businessId")({
  head: () => ({
    meta: [
      { title: "Project intake — Tempelia" },
      { name: "description", content: "Tell us about your concrete project and get a quote." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: IntakeForm,
});

const SURFACE_PREP = [
  "None (bare concrete already)",
  "Coating removal",
  "Epoxy removal",
  "Thinset removal",
  "Glue removal",
  "Wood floor removal",
  "Shot blasting",
  "Other",
] as const;

const FINISHES = [
  "Light Grind (prep for coating or epoxy)",
  "Heavy Grind (level or multiple passes)",
  "Matte-Satin",
  "Polished Shine",
  "High-Gloss Showroom Finish",
  "Epoxy — Decorative Flake",
  "Epoxy — Metallic",
  "Epoxy — Solid Color (Durable/Garage)",
  "Sealing",
  "Coating Removal Only",
  "Shot-Blasted Finish",
] as const;

const TIMING = ["Within a week", "Within a month", "Just getting quotes"] as const;

function IntakeForm() {
  const { businessId } = Route.useParams();
  const getInfo = useServerFn(getIntakeBusinessInfo);
  const submit = useServerFn(submitIntake);

  const { data: info } = useQuery({
    queryKey: ["intake-business", businessId],
    queryFn: () => getInfo({ data: { userId: businessId } }),
  });

  const [form, setForm] = useState({
    firstName: "",
    lastName: "",
    businessName: "",
    phone: "",
    email: "",
    address: "",
    projectType: "Residential" as "Residential" | "Commercial",
    squareFootage: "",
    concreteAge: "New concrete" as "New concrete" | "Old concrete",
    condition: "Good condition" as "Good condition" | "Cracked/damaged",
    surfacePrep: SURFACE_PREP[0] as (typeof SURFACE_PREP)[number],
    desiredFinish: FINISHES[0] as (typeof FINISHES)[number],
    timing: TIMING[0] as (typeof TIMING)[number],
    description: "",
  });
  const [files, setFiles] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  function upd<K extends keyof typeof form>(k: K, v: (typeof form)[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  function onFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const list = Array.from(e.target.files ?? []).slice(0, 5);
    const valid = list.filter((f) => f.size <= 8 * 1024 * 1024 && f.type.startsWith("image/"));
    if (valid.length < list.length) toast.error("Some files were skipped (must be images, <8MB).");
    setFiles(valid);
  }

  async function uploadPhotos(): Promise<string[]> {
    const paths: string[] = [];
    for (const file of files) {
      const ext = file.name.split(".").pop() || "jpg";
      const path = `${businessId}/${crypto.randomUUID()}.${ext}`;
      const { error } = await supabase.storage.from("intake-photos").upload(path, file, {
        contentType: file.type,
      });
      if (error) throw new Error(`Photo upload failed: ${error.message}`);
      paths.push(path);
    }
    return paths;
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      const photoPaths = await uploadPhotos();
      await submit({ data: { userId: businessId, ...form, photoPaths } });
      setDone(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Submission failed");
    } finally {
      setSubmitting(false);
    }
  }

  if (info && info.businessName === null) {
    return (
      <div className="min-h-screen bg-background text-foreground flex items-center justify-center p-6">
        <div className="panel max-w-md p-8 text-center">
          <h1 className="font-display text-2xl uppercase">Form not found</h1>
          <p className="mt-2 text-sm text-muted-foreground">This intake link is no longer active.</p>
        </div>
      </div>
    );
  }

  if (done) {
    return (
      <div className="min-h-screen bg-background text-foreground flex items-center justify-center p-6">
        <div className="panel max-w-md p-8 text-center">
          <div className="mono text-xs uppercase tracking-widest text-moss">// received</div>
          <h1 className="font-display text-3xl uppercase mt-2">Thanks — we got it.</h1>
          <p className="mt-3 text-sm text-muted-foreground">
            {info?.businessName || "The team"} will reach out shortly to follow up on your project.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-2xl p-5 md:p-10">
        <header className="mb-6">
          <div className="mono text-[10px] uppercase tracking-widest text-muted-foreground">// project intake</div>
          <h1 className="font-display text-3xl md:text-4xl uppercase mt-1">{info?.businessName || "Tempelia"}</h1>
          <p className="mt-2 text-sm text-muted-foreground">Tell us about your concrete project. Takes about 2 minutes.</p>
        </header>

        <form onSubmit={onSubmit} className="panel p-5 md:p-6 space-y-5">
          <Row>
            <Field label="First name *"><input required className={inp} value={form.firstName} onChange={(e) => upd("firstName", e.target.value)} /></Field>
            <Field label="Last name *"><input required className={inp} value={form.lastName} onChange={(e) => upd("lastName", e.target.value)} /></Field>
          </Row>
          <Field label="Business name (optional)"><input className={inp} value={form.businessName} onChange={(e) => upd("businessName", e.target.value)} /></Field>
          <Row>
            <Field label="Phone *"><input required type="tel" className={inp} value={form.phone} onChange={(e) => upd("phone", e.target.value)} /></Field>
            <Field label="Email (optional)"><input type="email" className={inp} value={form.email} onChange={(e) => upd("email", e.target.value)} /></Field>
          </Row>
          <Field label="Project location / address *"><input required className={inp} value={form.address} onChange={(e) => upd("address", e.target.value)} /></Field>

          <Row>
            <Field label="Type *">
              <select className={inp} value={form.projectType} onChange={(e) => upd("projectType", e.target.value as any)}>
                <option>Residential</option><option>Commercial</option>
              </select>
            </Field>
            <Field label="Square footage *"><input required className={inp} value={form.squareFootage} onChange={(e) => upd("squareFootage", e.target.value)} placeholder="e.g. 1200" /></Field>
          </Row>

          <Row>
            <Field label="Concrete age *">
              <select className={inp} value={form.concreteAge} onChange={(e) => upd("concreteAge", e.target.value as any)}>
                <option>New concrete</option><option>Old concrete</option>
              </select>
            </Field>
            <Field label="Condition *">
              <select className={inp} value={form.condition} onChange={(e) => upd("condition", e.target.value as any)}>
                <option>Good condition</option><option>Cracked/damaged</option>
              </select>
            </Field>
          </Row>

          <Field label="Surface prep needed *">
            <select className={inp} value={form.surfacePrep} onChange={(e) => upd("surfacePrep", e.target.value as any)}>
              {SURFACE_PREP.map((o) => <option key={o}>{o}</option>)}
            </select>
          </Field>

          <Field label="Desired finish *">
            <select className={inp} value={form.desiredFinish} onChange={(e) => upd("desiredFinish", e.target.value as any)}>
              {FINISHES.map((o) => <option key={o}>{o}</option>)}
            </select>
          </Field>

          <Field label="Timing *">
            <select className={inp} value={form.timing} onChange={(e) => upd("timing", e.target.value as any)}>
              {TIMING.map((o) => <option key={o}>{o}</option>)}
            </select>
          </Field>

          <Field label="Project description">
            <textarea rows={4} className={inp} value={form.description} onChange={(e) => upd("description", e.target.value)} placeholder="Anything else we should know?" />
          </Field>

          <Field label="Photos (up to 5)">
            <input type="file" accept="image/*" multiple onChange={onFiles} className="text-sm" />
            {files.length > 0 && <div className="mono text-xs text-muted-foreground mt-1">{files.length} file(s) selected</div>}
          </Field>

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-sm bg-violet px-4 py-3 font-display uppercase tracking-wider text-paper hover:opacity-90 disabled:opacity-50"
          >
            {submitting ? "Sending…" : "Submit project"}
          </button>
        </form>
      </div>
    </div>
  );
}

const inp = "w-full rounded-sm border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-violet";

function Row({ children }: { children: React.ReactNode }) {
  return <div className="grid gap-4 md:grid-cols-2">{children}</div>;
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <div className="label-eyebrow text-xs uppercase tracking-wider text-muted-foreground">{label}</div>
      {children}
    </label>
  );
}
