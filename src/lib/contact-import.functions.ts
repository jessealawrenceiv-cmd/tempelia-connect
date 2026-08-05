import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  IMPORT_ATTESTATION_TEXT,
  buildInsertNotes,
  buildMergePatch,
  type ExistingContact,
  type ImportSummary,
  type MappedRow,
  type SkipReason,
} from "./contact-import";

type CommitInput = {
  fileName: string;
  columnMapping: Record<string, string>;
  attestationAccepted: boolean;
  rows: MappedRow[];
};

function validate(data: unknown): CommitInput {
  const d = (data ?? {}) as Partial<CommitInput>;
  if (d.attestationAccepted !== true) {
    throw new Error("The attestation must be confirmed before importing contacts.");
  }
  if (!Array.isArray(d.rows) || d.rows.length === 0) throw new Error("No rows to import.");
  if (d.rows.length > 5000) throw new Error("Please import 5,000 rows or fewer at a time.");
  const rows = d.rows.map((r, i) => ({
    rowNumber: typeof r?.rowNumber === "number" ? r.rowNumber : i + 1,
    first_name: r?.first_name ?? null,
    last_name: r?.last_name ?? null,
    business_name: r?.business_name ?? null,
    phone: r?.phone ?? null,
    email: r?.email ?? null,
    notes: r?.notes ?? null,
    error: r?.error ?? null,
  })) as MappedRow[];
  return {
    fileName: typeof d.fileName === "string" ? d.fileName.slice(0, 200) : "import.csv",
    columnMapping: (d.columnMapping ?? {}) as Record<string, string>,
    attestationAccepted: true,
    rows,
  };
}

/**
 * Commit a mapped CSV import.
 *
 * HARD RULE: new contacts are always written with opt_in_consent = false and
 * consent_form_signed = false, and existing contacts' consent columns are
 * never touched. Nothing in the CSV can change that.
 */
export const commitContactImport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(validate)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    const skippedReasons: SkipReason[] = [];
    const valid: MappedRow[] = [];
    for (const r of data.rows) {
      if (r.error || !r.phone) {
        skippedReasons.push({ rowNumber: r.rowNumber, reason: r.error || "Missing phone number" });
      } else valid.push(r);
    }

    // Existing contacts for this business, matched on (user_id, phone_number).
    const phones = [...new Set(valid.map((r) => r.phone!))];
    const existingByPhone = new Map<string, ExistingContact & { phone_number: string }>();
    for (let i = 0; i < phones.length; i += 200) {
      const chunk = phones.slice(i, i + 200);
      const { data: found, error } = await supabase
        .from("customers")
        .select("id, phone_number, first_name, last_name, email, notes")
        .eq("user_id", userId)
        .in("phone_number", chunk);
      if (error) throw new Error(error.message);
      (found ?? []).forEach((c: any) => existingByPhone.set(c.phone_number, c));
    }

    let imported = 0;
    let updated = 0;

    const toInsert = valid.filter((r) => !existingByPhone.has(r.phone!));
    for (let i = 0; i < toInsert.length; i += 200) {
      const chunk = toInsert.slice(i, i + 200).map((r) => ({
        user_id: userId,
        first_name: r.first_name ?? "",
        last_name: r.last_name,
        phone_number: r.phone!,
        email: r.email,
        notes: buildInsertNotes(r),
        source: "import",
        // Consent is NEVER imported.
        opt_in_consent: false,
        consent_form_signed: false,
      }));
      const { data: ins, error } = await supabase.from("customers").insert(chunk).select("id");
      if (error) {
        chunk.forEach((_, k) =>
          skippedReasons.push({
            rowNumber: toInsert[i + k]!.rowNumber,
            reason: `Could not be saved: ${error.message}`,
          }),
        );
      } else imported += ins?.length ?? chunk.length;
    }

    // Non-destructive merge: only fill blank fields on existing contacts.
    for (const r of valid) {
      const existing = existingByPhone.get(r.phone!);
      if (!existing) continue;
      const patch = buildMergePatch(existing, r);
      if (Object.keys(patch).length === 0) continue;
      const { error } = await supabase
        .from("customers")
        .update(patch as { first_name?: string; last_name?: string; email?: string; notes?: string })
        .eq("id", existing.id);
      if (error) {
        skippedReasons.push({ rowNumber: r.rowNumber, reason: `Could not be updated: ${error.message}` });
      } else updated++;
    }

    const summary: ImportSummary = {
      totalRows: data.rows.length,
      imported,
      updated,
      matchedExisting: valid.filter((r) => existingByPhone.has(r.phone!)).length,
      skipped: skippedReasons.length,
      collapsedDuplicates: 0,
      skippedReasons,
    };

    const { data: event, error: logErr } = await supabase
      .from("contact_import_events")
      .insert({
        user_id: userId,
        actor_user_id: userId,
        file_name: data.fileName,
        column_mapping: data.columnMapping,
        attestation_text: IMPORT_ATTESTATION_TEXT,
        attestation_accepted_at: new Date().toISOString(),
        total_rows: summary.totalRows,
        imported_count: summary.imported,
        updated_count: summary.updated,
        skipped_count: summary.skipped,
        skipped_reasons: skippedReasons.slice(0, 200),
      })
      .select("id, occurred_at")
      .single();
    if (logErr) throw new Error(`Import saved but audit log failed: ${logErr.message}`);

    return { summary, eventId: event?.id ?? null, occurredAt: event?.occurred_at ?? null };
  });

/** Recent import audit entries for this business. */
export const listContactImportEvents = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("contact_import_events")
      .select("*")
      .order("occurred_at", { ascending: false })
      .limit(10);
    if (error) throw new Error(error.message);
    return data ?? [];
  });
