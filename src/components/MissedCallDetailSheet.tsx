import { useQuery } from "@tanstack/react-query";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { supabase } from "@/integrations/supabase/client";
import { OPT_IN_PROMPT_ACTION } from "@/lib/opt-in-prompt";

export type MissedCallDetail = {
  id: string;
  created_at: string;
  action_type: string;
  status: string;
  message_sent: string | null;
  twilio_message_sid: string | null;
  voicemail_url: string | null;
  call_sid?: string | null;
  recording_sid?: string | null;
  customer_id: string | null;
};

type Props = {
  log: MissedCallDetail | null;
  onClose: () => void;
};

function fmt(s: string | null | undefined) {
  return s ? new Date(s).toLocaleString() : "—";
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 border-b border-border py-2">
      <span className="label-eyebrow">{label}</span>
      <span className="mono break-words text-xs text-paper">{value ?? "—"}</span>
    </div>
  );
}

export function MissedCallDetailSheet({ log, onClose }: Props) {
  const customerId = log?.customer_id ?? null;

  const { data: customer } = useQuery({
    queryKey: ["missed-call-customer", customerId],
    enabled: !!customerId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("customers")
        .select(
          "id, first_name, last_name, phone_number, email, source, opt_in_consent, sms_opt_in_at, consent_form_signed, notes, created_at",
        )
        .eq("id", customerId!)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const { data: lastConsent } = useQuery({
    queryKey: ["missed-call-consent", customerId],
    enabled: !!customerId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sms_consent_events")
        .select("keyword, action, occurred_at, phone_number")
        .eq("customer_id", customerId!)
        .order("occurred_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const { data: lastPrompt } = useQuery({
    queryKey: ["missed-call-last-prompt", customerId],
    enabled: !!customerId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("logs")
        .select("id, created_at, status, message_sent, twilio_message_sid")
        .eq("customer_id", customerId!)
        .eq("action_type", OPT_IN_PROMPT_ACTION)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  return (
    <Sheet open={!!log} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle className="label-eyebrow">Missed call detail</SheetTitle>
        </SheetHeader>

        {log && (
          <div className="mt-4 space-y-6">
            <section>
              <div className="label-eyebrow mb-1 text-violet">Call event</div>
              <Row label="Time" value={fmt(log.created_at)} />
              <Row label="Event type" value={log.action_type.replace(/_/g, " ")} />
              <Row label="Status" value={log.status} />
              <Row label="Auto-reply body" value={log.message_sent || "—"} />
              <Row label="Twilio message SID" value={log.twilio_message_sid || "not confirmed"} />
              <Row label="Call SID" value={log.call_sid || "—"} />
              <Row label="Recording SID" value={log.recording_sid || "—"} />
              <Row label="Voicemail" value={log.voicemail_url ? "recorded" : "none"} />
              <Row label="Log ID" value={log.id} />
            </section>

            <section>
              <div className="label-eyebrow mb-1 text-violet">Customer record</div>
              {customerId ? (
                <>
                  <Row
                    label="Name"
                    value={
                      [customer?.first_name, customer?.last_name].filter(Boolean).join(" ") ||
                      "Unknown"
                    }
                  />
                  <Row label="Phone" value={customer?.phone_number} />
                  <Row label="Email" value={customer?.email || "—"} />
                  <Row label="Source" value={customer?.source} />
                  <Row
                    label="SMS consent"
                    value={customer?.opt_in_consent ? "opted in" : "not opted in"}
                  />
                  <Row label="Opted in at" value={fmt(customer?.sms_opt_in_at)} />
                  <Row
                    label="Consent form"
                    value={customer?.consent_form_signed ? "signed" : "not signed"}
                  />
                  <Row label="Notes" value={customer?.notes || "—"} />
                  <Row label="Contact ID" value={customerId} />
                </>
              ) : (
                <p className="mono text-xs italic text-muted-foreground">
                  // no contact linked to this call
                </p>
              )}
            </section>

            <section>
              <div className="label-eyebrow mb-1 text-violet">Last opt-in keyword</div>
              {lastConsent ? (
                <>
                  <Row label="Keyword" value={lastConsent.keyword?.toUpperCase()} />
                  <Row
                    label="Action"
                    value={lastConsent.action === "opt_in" ? "opt-in" : "opt-out"}
                  />
                  <Row label="From number" value={lastConsent.phone_number} />
                  <Row label="Received" value={fmt(lastConsent.occurred_at)} />
                </>
              ) : (
                <p className="mono text-xs italic text-muted-foreground">
                  // no keyword received
                </p>
              )}
            </section>

            <section>
              <div className="label-eyebrow mb-1 text-violet">Last opt-in prompt sent</div>
              {lastPrompt ? (
                <>
                  <Row label="Sent" value={fmt(lastPrompt.created_at)} />
                  <Row label="Status" value={lastPrompt.status} />
                  <Row
                    label="Twilio SID"
                    value={
                      lastPrompt.twilio_message_sid || (
                        <span className="text-destructive">
                          none — send failed or delivery unconfirmed
                        </span>
                      )
                    }
                  />
                  <Row label="Body" value={lastPrompt.message_sent || "—"} />
                </>
              ) : (
                <p className="mono text-xs italic text-muted-foreground">
                  // no opt-in prompt sent yet
                </p>
              )}
            </section>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
