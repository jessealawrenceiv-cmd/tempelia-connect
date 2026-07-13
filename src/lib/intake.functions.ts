import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const submitSchema = z.object({
  userId: z.string().uuid(),
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  businessName: z.string().trim().max(120).optional().nullable(),
  phone: z.string().trim().min(5).max(30),
  email: z.string().trim().email().max(200).optional().nullable().or(z.literal("")),
  address: z.string().trim().min(1).max(300),
  projectType: z.enum(["Residential", "Commercial"]),
  squareFootage: z.string().trim().min(1).max(30),
  concreteAge: z.enum(["New concrete", "Old concrete"]),
  condition: z.enum(["Good condition", "Cracked/damaged"]),
  surfacePrep: z.enum([
    "None (bare concrete already)",
    "Coating removal",
    "Epoxy removal",
    "Thinset removal",
    "Glue removal",
    "Wood floor removal",
    "Shot blasting",
    "Other",
  ]),
  desiredFinish: z.enum([
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
  ]),
  timing: z.enum(["Within a week", "Within a month", "Just getting quotes"]),
  description: z.string().trim().max(4000).optional().nullable(),
  photoPaths: z.array(z.string().max(500)).max(5).default([]),
});

export const getIntakeBusinessInfo = createServerFn({ method: "GET" })
  .inputValidator((d: { userId: string }) => z.object({ userId: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: prof } = await supabaseAdmin
      .from("profiles")
      .select("business_name")
      .eq("id", data.userId)
      .maybeSingle();
    if (!prof) return { businessName: null as string | null };
    return { businessName: prof.business_name || null };
  });

export const submitIntake = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => submitSchema.parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // Verify target business exists
    const { data: prof } = await supabaseAdmin
      .from("profiles")
      .select("id")
      .eq("id", data.userId)
      .maybeSingle();
    if (!prof) throw new Error("Business not found");

    const responses = {
      address: data.address,
      project_type: data.projectType,
      square_footage: data.squareFootage,
      concrete_age: data.concreteAge,
      condition: data.condition,
      surface_prep: data.surfacePrep,
      desired_finish: data.desiredFinish,
      timing: data.timing,
      description: data.description ?? "",
    };

    const { data: row, error } = await supabaseAdmin
      .from("intake_submissions")
      .insert({
        user_id: data.userId,
        customer_first_name: data.firstName,
        customer_last_name: data.lastName,
        customer_business_name: data.businessName || null,
        customer_phone: data.phone,
        customer_email: data.email || null,
        responses,
        photo_urls: data.photoPaths,
        source: "public_form",
        status: "new",
      })
      .select("id")
      .single();

    if (error) throw new Error(error.message);
    return { id: row.id };
  });

export const listIntakes = createServerFn({ method: "GET" })
  .handler(async () => {
    // Placeholder — dashboard uses the browser client directly under RLS
    return { ok: true };
  });

export const signIntakePhotos = createServerFn({ method: "POST" })
  .inputValidator((d: { paths: string[] }) =>
    z.object({ paths: z.array(z.string()).max(50) }).parse(d),
  )
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const results: Record<string, string> = {};
    for (const path of data.paths) {
      const { data: signed } = await supabaseAdmin.storage
        .from("intake-photos")
        .createSignedUrl(path, 3600);
      if (signed?.signedUrl) results[path] = signed.signedUrl;
    }
    return { urls: results };
  });
