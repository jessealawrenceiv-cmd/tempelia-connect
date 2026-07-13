import { createServerFn } from "@tanstack/react-start";
import { getRequestHeader } from "@tanstack/react-start/server";
import { z } from "zod";
import { createHash } from "crypto";

// ─── Enforced limits ─────────────────────────────────────────────
export const INTAKE_LIMITS = {
  MAX_PHOTOS: 5,
  MAX_BYTES_PER_PHOTO: 5 * 1024 * 1024,       //  5 MB per photo
  MAX_BYTES_PER_SUBMISSION: 20 * 1024 * 1024, // 20 MB total per submission
  ALLOWED_MIME: ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"] as const,
  // Per (user_id + ip_hash) window
  RATE_LIMIT_WINDOW_MIN: 60,
  RATE_LIMIT_MAX: 5,
  // Global per-business ceiling across ALL IPs — catches distributed spam
  BUSINESS_CEILING_WINDOW_MIN: 60,
  BUSINESS_CEILING_MAX: 30,
} as const;

// ─── Magic-byte sniff (don't trust client-provided MIME) ─────────
function sniffImageMime(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null;
  // JPEG  FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  // PNG   89 50 4E 47 0D 0A 1A 0A
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  // WEBP  "RIFF"...."WEBP"
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) return "image/webp";
  // HEIC/HEIF ftyp box at offset 4: "ftyp" + heic|heix|hevc|mif1|msf1|heim|heis|hevm|hevs
  if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
    const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
    if (["heic", "heix", "hevc", "hevm", "hevs", "heim", "heis", "mif1", "msf1"].includes(brand)) {
      return "image/heic";
    }
  }
  return null;
}

const photoSchema = z.object({
  filename: z.string().max(200),
  contentType: z.string().max(100),
  // base64 encoded bytes
  dataBase64: z.string().max(Math.ceil((INTAKE_LIMITS.MAX_BYTES_PER_PHOTO * 4) / 3) + 128),
});

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
  photos: z.array(photoSchema).max(INTAKE_LIMITS.MAX_PHOTOS).default([]),
  // Honeypot — real users leave this blank; bots fill it in.
  website: z.string().max(200).optional().nullable(),
});

function hashIp(ip: string): string {
  return createHash("sha256").update(ip).digest("hex").slice(0, 32);
}

function clientIp(): string {
  // Cloudflare sets and OVERWRITES cf-connecting-ip on every request — clients cannot spoof it.
  const cf = getRequestHeader("cf-connecting-ip");
  if (cf) return cf.trim();
  const real = getRequestHeader("x-real-ip");
  if (real) return real.trim();
  // Fallback: take the LAST hop of x-forwarded-for (closest to our server),
  // never the first (attacker-controlled). Still only a fallback.
  const fwd = getRequestHeader("x-forwarded-for") || "";
  const parts = fwd.split(",").map((s) => s.trim()).filter(Boolean);
  return parts[parts.length - 1] || "0.0.0.0";
}



export const getIntakeBusinessInfo = createServerFn({ method: "GET" })
  .inputValidator((d: { userId: string }) => z.object({ userId: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: prof } = await supabaseAdmin
      .from("profiles")
      .select("business_name, intake_enabled")
      .eq("id", data.userId)
      .maybeSingle();
    if (!prof || !prof.intake_enabled) return { businessName: null as string | null };
    return { businessName: prof.business_name || null };
  });

export const submitIntake = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => submitSchema.parse(d))
  .handler(async ({ data }) => {
    // Honeypot: silently accept (return ok) but do nothing.
    if (data.website && data.website.trim().length > 0) {
      return { id: "ok" };
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // Verify target business exists AND has intake enabled
    const { data: prof } = await supabaseAdmin
      .from("profiles")
      .select("id, intake_enabled")
      .eq("id", data.userId)
      .maybeSingle();
    if (!prof) throw new Error("Business not found");
    if (!prof.intake_enabled) throw new Error("This intake form is not accepting submissions");

    // Rate limit #1: per (business, IP) — catches a single spammer
    const ipHash = hashIp(clientIp());
    const windowStart = new Date(Date.now() - INTAKE_LIMITS.RATE_LIMIT_WINDOW_MIN * 60_000).toISOString();
    const { count: perIpCount } = await supabaseAdmin
      .from("intake_rate_limits")
      .select("id", { count: "exact", head: true })
      .eq("user_id", data.userId)
      .eq("ip_hash", ipHash)
      .gte("submitted_at", windowStart);
    if ((perIpCount ?? 0) >= INTAKE_LIMITS.RATE_LIMIT_MAX) {
      throw new Error("Too many submissions. Please try again later.");
    }

    // Rate limit #2: global per-business ceiling across ALL IPs — floor against
    // distributed / botnet spam that rotates source IPs.
    const ceilingWindowStart = new Date(
      Date.now() - INTAKE_LIMITS.BUSINESS_CEILING_WINDOW_MIN * 60_000,
    ).toISOString();
    const { count: perBizCount } = await supabaseAdmin
      .from("intake_rate_limits")
      .select("id", { count: "exact", head: true })
      .eq("user_id", data.userId)
      .gte("submitted_at", ceilingWindowStart);
    if ((perBizCount ?? 0) >= INTAKE_LIMITS.BUSINESS_CEILING_MAX) {
      throw new Error("This form is temporarily paused due to unusual traffic. Try again later.");
    }

    // ── Photo validation + server-side upload ──────────────────
    let totalBytes = 0;
    const decoded: { path: string; bytes: Uint8Array; mime: string }[] = [];
    for (const p of data.photos) {
      const bytes = Uint8Array.from(Buffer.from(p.dataBase64, "base64"));
      if (bytes.length === 0) throw new Error("Empty photo rejected");
      if (bytes.length > INTAKE_LIMITS.MAX_BYTES_PER_PHOTO) {
        throw new Error(`Photo exceeds ${INTAKE_LIMITS.MAX_BYTES_PER_PHOTO / 1024 / 1024} MB limit`);
      }
      totalBytes += bytes.length;
      if (totalBytes > INTAKE_LIMITS.MAX_BYTES_PER_SUBMISSION) {
        throw new Error(`Photos exceed ${INTAKE_LIMITS.MAX_BYTES_PER_SUBMISSION / 1024 / 1024} MB total limit`);
      }
      const sniffed = sniffImageMime(bytes);
      if (!sniffed || !INTAKE_LIMITS.ALLOWED_MIME.includes(sniffed as (typeof INTAKE_LIMITS.ALLOWED_MIME)[number])) {
        throw new Error("Only JPEG, PNG, WebP, or HEIC images are allowed");
      }
      const ext = sniffed === "image/jpeg" ? "jpg" : sniffed.split("/")[1];
      const path = `${data.userId}/${crypto.randomUUID()}.${ext}`;
      decoded.push({ path, bytes, mime: sniffed });
    }

    const uploadedPaths: string[] = [];
    for (const d of decoded) {
      const { error } = await supabaseAdmin.storage
        .from("intake-photos")
        .upload(d.path, d.bytes, { contentType: d.mime, upsert: false });
      if (error) throw new Error(`Photo upload failed: ${error.message}`);
      uploadedPaths.push(d.path);
    }

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
        photo_urls: uploadedPaths,
        source: "public_form",
        status: "new",
      })
      .select("id")
      .single();

    if (error) throw new Error(error.message);

    // Auto-promote intake into Contacts (dedupe on user_id + phone_number).
    // On phone collision we MERGE the latest intake info onto the existing contact
    // (name, email, source) so the intake is always reflected in Contacts.
    // Consent columns (opt_in_consent, sms_opt_in_at, consent_form_signed*) are
    // intentionally omitted so an existing opted-in contact isn't downgraded.
    const { data: cust } = await supabaseAdmin
      .from("customers")
      .upsert(
        {
          user_id: data.userId,
          first_name: data.firstName,
          last_name: data.lastName,
          phone_number: data.phone,
          email: data.email || null,
          source: "intake",
        },
        { onConflict: "user_id,phone_number" },
      )
      .select("id")
      .single();

    // Stamp the resolved customer_id back onto the submission so the link is
    // explicit (not just implicitly matched by phone).
    if (cust?.id) {
      await supabaseAdmin
        .from("intake_submissions")
        .update({ customer_id: cust.id })
        .eq("id", row.id);
    }

    // Log rate-limit hit only on success
    await supabaseAdmin
      .from("intake_rate_limits")
      .insert({ user_id: data.userId, ip_hash: ipHash });

    return { id: row.id };

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
