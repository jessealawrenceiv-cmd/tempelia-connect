import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

interface SendInput {
  customerId: string;
  jobValue?: number;
  intakeSubmissionId?: string;
}

function validateInput(data: unknown): SendInput {
  if (!data || typeof data !== "object") throw new Error("Invalid input");
  const { customerId, jobValue, intakeSubmissionId } = data as {
    customerId?: unknown;
    jobValue?: unknown;
    intakeSubmissionId?: unknown;
  };
  if (typeof customerId !== "string" || customerId.length < 8) throw new Error("Invalid customerId");
  if (jobValue !== undefined && (typeof jobValue !== "number" || jobValue < 0)) throw new Error("Invalid jobValue");
  if (intakeSubmissionId !== undefined && typeof intakeSubmissionId !== "string") throw new Error("Invalid intakeSubmissionId");
  return { customerId, jobValue, intakeSubmissionId };
}

// Normalize a phone number to digits-only for comparison with excluded_numbers.
function normalizePhone(p: string | null | undefined): string {
  return (p || "").replace(/\D+/g, "");
}

export const completeJob = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(validateInput)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { sendTwilioSms, STOP_SUFFIX } = await import("./twilio.server");

    const { data: cust, error: custErr } = await supabase
      .from("customers").select("*").eq("id", data.customerId).maybeSingle();
    if (custErr) throw new Error(custErr.message);
    if (!cust) throw new Error("Customer not found");

    const { data: prof } = await supabase.from("profiles")
      .select("business_name, twilio_phone_number, review_requests_enabled").eq("id", userId).maybeSingle();

    // 1. Always record the completed job for revenue tracking.
    const { data: job, error: jobErr } = await supabase.from("jobs").insert({
      user_id: userId,
      customer_id: cust.id,
      intake_submission_id: data.intakeSubmissionId || null,
      job_value: data.jobValue ?? null,
      completed_at: new Date().toISOString(),
      status: "completed",
    }).select().single();
    if (jobErr) throw new Error(jobErr.message);

    // 2. Gate: is the review-request feature turned on for this business?
    if (prof?.review_requests_enabled === false) {
      await supabase.from("logs").insert({
        user_id: userId, customer_id: cust.id, action_type: "review_request",
        message_sent: null, status: "skipped_disabled",
      });
      await supabase.from("jobs").update({ status: "completed_no_request" }).eq("id", job.id);
      return { ok: true, jobId: job.id, sent: false, reason: "disabled" as const };
    }

    // 3. Gate: is this number on the exclusion list?
    const custDigits = normalizePhone(cust.phone_number);
    const { data: excluded } = await supabase.from("excluded_numbers")
      .select("phone_number").eq("user_id", userId);
    const isExcluded = (excluded ?? []).some((r) => normalizePhone(r.phone_number) === custDigits);
    if (isExcluded) {
      await supabase.from("logs").insert({
        user_id: userId, customer_id: cust.id, action_type: "review_request",
        message_sent: null, status: "skipped_excluded",
      });
      await supabase.from("jobs").update({ status: "completed_no_request" }).eq("id", job.id);
      return { ok: true, jobId: job.id, sent: false, reason: "excluded" as const };
    }

    // 4. Gate: has the customer opted in?
    const biz = prof?.business_name || "our team";
    const from = prof?.twilio_phone_number;
    const { data: intg } = await supabase.from("integrations")
      .select("google_review_url").eq("user_id", userId).maybeSingle();
    const url = intg?.google_review_url || "";
    const linkLine = url ? ` ${url}` : "";
    const message = `Thanks for choosing ${biz}! Mind leaving us a quick review?${linkLine}${STOP_SUFFIX}`;

    if (!cust.opt_in_consent) {
      await supabase.from("logs").insert({
        user_id: userId, customer_id: cust.id, action_type: "review_request",
        message_sent: message, status: "needs_consent",
      });
      await supabase.from("jobs").update({ status: "needs_consent" }).eq("id", job.id);
      return { ok: true, jobId: job.id, sent: false, reason: "needs_consent" as const };
    }

    if (!from) {
      await supabase.from("logs").insert({
        user_id: userId, customer_id: cust.id, action_type: "review_request",
        message_sent: message, status: "failed",
      });
      await supabase.from("jobs").update({ status: "failed" }).eq("id", job.id);
      throw new Error("Provision your Temora number in Settings before sending.");
    }

    // 5. Send.
    try {
      const res = await sendTwilioSms(from, cust.phone_number, message);
      await supabase.from("customers").update({
        last_service_date: new Date().toISOString().slice(0, 10),
      }).eq("id", cust.id);
      await supabase.from("logs").insert({
        user_id: userId, customer_id: cust.id, action_type: "review_request",
        message_sent: message, status: "sent", twilio_message_sid: res.sid,
      });
      await supabase.from("jobs").update({ status: "review_requested" }).eq("id", job.id);
      return { ok: true, jobId: job.id, sent: true, sid: res.sid };
    } catch (e) {
      await supabase.from("logs").insert({
        user_id: userId, customer_id: cust.id, action_type: "review_request",
        message_sent: message, status: "failed",
      });
      await supabase.from("jobs").update({ status: "failed" }).eq("id", job.id);
      throw e;
    }
  });

// Kept for backwards compatibility; delegates to completeJob.
export const sendReviewRequest = completeJob;

export const sendReactivation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(validateInput)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { sendTwilioSms, STOP_SUFFIX } = await import("./twilio.server");

    const { data: cust, error: custErr } = await supabase
      .from("customers").select("*").eq("id", data.customerId).maybeSingle();
    if (custErr) throw new Error(custErr.message);
    if (!cust) throw new Error("Customer not found");

    const { data: prof } = await supabase.from("profiles")
      .select("twilio_phone_number").eq("id", userId).maybeSingle();
    const from = prof?.twilio_phone_number;
    if (!from) throw new Error("Provision your Temora number in Settings before sending.");

    // Respect excluded_numbers for reactivations too.
    const custDigits = normalizePhone(cust.phone_number);
    const { data: excluded } = await supabase.from("excluded_numbers")
      .select("phone_number").eq("user_id", userId);
    const isExcluded = (excluded ?? []).some((r) => normalizePhone(r.phone_number) === custDigits);
    if (isExcluded) {
      await supabase.from("logs").insert({
        user_id: userId, customer_id: cust.id, action_type: "reactivation_text",
        message_sent: null, status: "skipped_excluded",
      });
      throw new Error(`${cust.first_name || "Customer"} is on your exclusion list — skipped.`);
    }

    const message = `Hi ${cust.first_name || "there"}, it's been a while! Want us to swing by for a seasonal check-up?${STOP_SUFFIX}`;

    if (!cust.opt_in_consent) {
      await supabase.from("logs").insert({
        user_id: userId, customer_id: cust.id, action_type: "reactivation_text",
        message_sent: message, status: "needs_consent",
      });
      throw new Error(`${cust.first_name || "Customer"} needs consent — flagged.`);
    }

    try {
      const res = await sendTwilioSms(from, cust.phone_number, message);
      await supabase.from("customers").update({ last_reactivation_at: new Date().toISOString() }).eq("id", cust.id);
      await supabase.from("logs").insert({
        user_id: userId, customer_id: cust.id, action_type: "reactivation_text",
        message_sent: message, status: "sent", twilio_message_sid: res.sid,
      });
      return { ok: true, sid: res.sid };
    } catch (e) {
      await supabase.from("logs").insert({
        user_id: userId, customer_id: cust.id, action_type: "reactivation_text",
        message_sent: message, status: "failed",
      });
      throw e;
    }
  });
