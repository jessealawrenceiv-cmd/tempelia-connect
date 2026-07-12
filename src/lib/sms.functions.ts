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

export const sendReviewRequest = createServerFn({ method: "POST" })
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
      .select("business_name, twilio_phone_number").eq("id", userId).maybeSingle();
    const { data: intg } = await supabase.from("integrations").select("google_review_url").eq("user_id", userId).maybeSingle();
    const biz = prof?.business_name || "our team";
    const from = prof?.twilio_phone_number;
    if (!from) throw new Error("Provision your Tempelia number in Settings before sending.");
    const url = intg?.google_review_url || "";
    const linkLine = url ? ` ${url}` : "";
    const message = `Thanks for choosing ${biz}! Mind leaving us a quick review?${linkLine}${STOP_SUFFIX}`;

    const { data: job, error: jobErr } = await supabase.from("jobs").insert({
      user_id: userId,
      customer_id: cust.id,
      intake_submission_id: data.intakeSubmissionId || null,
      job_value: data.jobValue ?? null,
      completed_at: new Date().toISOString(),
      status: "pending",
    }).select().single();
    if (jobErr) throw new Error(jobErr.message);

    if (!cust.opt_in_consent) {
      await supabase.from("logs").insert({
        user_id: userId, customer_id: cust.id, action_type: "review_request",
        message_sent: message, status: "needs_consent",
      });
      await supabase.from("jobs").update({ status: "needs_consent" }).eq("id", job.id);
      throw new Error(`${cust.first_name || "Customer"} has not opted in. Flagged as needs-consent.`);
    }

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
      return { ok: true, sid: res.sid, jobId: job.id };
    } catch (e) {
      await supabase.from("logs").insert({
        user_id: userId, customer_id: cust.id, action_type: "review_request",
        message_sent: message, status: "failed",
      });
      await supabase.from("jobs").update({ status: "failed" }).eq("id", job.id);
      throw e;
    }
  });

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
    if (!from) throw new Error("Provision your Tempelia number in Settings before sending.");

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
