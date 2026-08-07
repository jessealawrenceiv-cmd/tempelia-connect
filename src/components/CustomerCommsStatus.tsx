import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { resendLastMessage } from "@/lib/resend-sms.functions";
import { RESENDABLE_STATUSES } from "@/lib/resend-sms";
import { LogAction } from "@/lib/log-action-types";
import { logActionFilterValues } from "@/lib/log-action-query";


/** Log action types that represent messages WE sent to the customer. */
const OUTBOUND_TYPES = [
  LogAction.quote_sms,
  LogAction.review_request,
  LogAction.missed_call_text,
  LogAction.missed_call_autotext,
  LogAction.reactivation_text,
  LogAction.quote_decline_followup,
] as const;

/** Log action types that represent messages the customer sent to US. */
const INBOUND_TYPES = [LogAction.sms_inbound, LogAction.quote_decline_reason_captured] as const;

type Props = {
  customerId: string | null | undefined;
  optInConsent: boolean;
  smsOptInAt?: string | null;
};

type LogRow = {
  id: string;
  action_type: string;
  status: string;
  message_sent: string | null;
  twilio_message_sid?: string | null;
  created_at: string;

};

type ConsentRow = {
  keyword: string;
  action: "opt_in" | "opt_out";
  occurred_at: string;
};

function fmtDateTime(s: string | null | undefined) {
  return s ? new Date(s).toLocaleString() : "—";
}

function firstWord(s: string | null | undefined) {
  const w = (s ?? "").trim().split(/\s+/)[0];
  return w ? w.toUpperCase() : null;
}

export function CustomerCommsStatus({ customerId, optInConsent, smsOptInAt }: Props) {
  const enabled = !!customerId;
  const queryClient = useQueryClient();
  const resendFn = useServerFn(resendLastMessage);


  const { data: lastInbound } = useQuery({
    queryKey: ["comms-last-inbound", customerId],
    enabled,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("logs")
        .select("id, action_type, status, message_sent, created_at")
        .eq("customer_id", customerId!)
        .in("action_type", logActionFilterValues(INBOUND_TYPES))
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return (data ?? null) as LogRow | null;
    },
  });

  const { data: lastOutbound } = useQuery({
    queryKey: ["comms-last-outbound", customerId],
    enabled,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("logs")
        .select("id, action_type, status, message_sent, twilio_message_sid, created_at")
        .eq("customer_id", customerId!)
        .in("action_type", logActionFilterValues(OUTBOUND_TYPES))
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return (data ?? null) as LogRow | null;
    },
  });

  const { data: lastConsent } = useQuery({
    queryKey: ["comms-last-consent", customerId],
    enabled,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sms_consent_events")
        .select("keyword, action, occurred_at")
        .eq("customer_id", customerId!)
        .order("occurred_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return (data ?? null) as ConsentRow | null;
    },
  });

  const resend = useMutation({
    mutationFn: async () => resendFn({ data: { customerId: customerId! } }),
    onSuccess: () => {
      toast.success("Message re-sent");
      queryClient.invalidateQueries({ queryKey: ["comms-last-outbound", customerId] });
      queryClient.invalidateQueries({ queryKey: ["customer-logs", customerId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (!customerId) return null;

  // Prefer the audited consent keyword; fall back to the first word of the
  // most recent inbound text (e.g. a decline reason or free-form reply).
  const keyword = lastConsent?.keyword ?? firstWord(lastInbound?.message_sent);
  const keywordAt = lastConsent?.occurred_at ?? lastInbound?.created_at ?? null;
  const keywordIsConsent = !!lastConsent;

  // Delivery is unconfirmed when Twilio reported a failure, or when we never
  // recorded a message SID / delivery confirmation from the webhook.
  const canResend =
    !!lastOutbound &&
    !!lastOutbound.message_sent &&
    optInConsent &&
    (RESENDABLE_STATUSES.includes(lastOutbound.status) || !lastOutbound.twilio_message_sid);


  return (
    <section className="rounded-sm border border-border bg-background/40 p-3">
      <div className="label-eyebrow mb-3">Comms status</div>
      <dl className="grid gap-3 sm:grid-cols-3">
        {/* SMS consent */}
        <div>
          <dt className="mono text-[10px] uppercase tracking-widest text-muted-foreground">
            SMS consent
          </dt>
          <dd className="mt-1">
            <span
              className={`rounded-sm px-2 py-0.5 mono text-[10px] uppercase tracking-wider ${
                optInConsent ? "bg-moss/30 text-paper" : "bg-destructive/20 text-paper"
              }`}
            >
              {optInConsent ? "opted in" : "not opted in"}
            </span>
            <div className="mono mt-1 text-[10px] text-muted-foreground">
              {optInConsent
                ? `since ${fmtDateTime(smsOptInAt)}`
                : lastConsent?.action === "opt_out"
                  ? `opted out ${fmtDateTime(lastConsent.occurred_at)}`
                  : "no consent on file"}
            </div>
          </dd>
        </div>

        {/* Last keyword received */}
        <div>
          <dt className="mono text-[10px] uppercase tracking-widest text-muted-foreground">
            Last keyword received
          </dt>
          <dd className="mt-1">
            {keyword ? (
              <>
                <span className="mono text-sm text-paper">{keyword}</span>
                <div className="mono mt-1 text-[10px] text-muted-foreground">
                  {fmtDateTime(keywordAt)}
                  {keywordIsConsent
                    ? ` · ${lastConsent!.action === "opt_in" ? "opt-in" : "opt-out"}`
                    : " · inbound reply"}
                </div>
              </>
            ) : (
              <span className="mono text-xs italic text-muted-foreground">
                // nothing received
              </span>
            )}
          </dd>
        </div>

        {/* Last message sent */}
        <div>
          <dt className="mono text-[10px] uppercase tracking-widest text-muted-foreground">
            Last message sent
          </dt>
          <dd className="mt-1">
            {lastOutbound ? (
              <>
                <div className="mono text-[10px] uppercase tracking-wider text-muted-foreground">
                  {lastOutbound.action_type.replace(/_/g, " ")} · {lastOutbound.status} ·{" "}
                  {fmtDateTime(lastOutbound.created_at)}
                  {!lastOutbound.twilio_message_sid && (
                    <span className="text-destructive"> · delivery unconfirmed</span>
                  )}
                </div>
                <p className="mono mt-1 whitespace-pre-wrap text-xs text-paper">
                  {lastOutbound.message_sent || "— no body recorded —"}
                </p>
                {canResend && (
                  <button
                    type="button"
                    onClick={() => resend.mutate()}
                    disabled={resend.isPending}
                    className="mono mt-2 rounded-sm border border-primary/60 px-2 py-1 text-[10px] uppercase tracking-wider text-paper hover:bg-primary/20 disabled:opacity-50"
                  >
                    {resend.isPending ? "Re-sending…" : "Resend last message"}
                  </button>
                )}
              </>
            ) : (

              <span className="mono text-xs italic text-muted-foreground">
                // nothing sent yet
              </span>
            )}
          </dd>
        </div>
      </dl>
    </section>
  );
}
