/**
 * Integration test: a Twilio webhook payload carrying an INVALID action_type
 * must be blocked by the server write guard, identically for every webhook
 * branch (inbound SMS, opt-out, opt-in, missed call, recording callback).
 *
 * The guard lives in insertLog / insertLogReturningId (src/lib/log-action-types.ts),
 * which is the only module allowed to write public.logs. Here we drive it with
 * realistic Twilio form payloads and assert:
 *   - nothing reaches Postgres,
 *   - the returned error mirrors logs_action_type_check (code 23514 + hint),
 *   - valid payloads on the same path still write.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  LOG_ACTION_TYPE_CONSTRAINT,
  LogAction,
  insertLog,
  insertLogReturningId,
} from "@/lib/log-action-types";

type Row = Record<string, unknown>;

const logInserts: Row[] = [];

function fakeAdminClient() {
  return {
    from: (_table: "logs") => {
      const chain = {
        insert: (rows: Row | Row[]) => {
          logInserts.push(...(Array.isArray(rows) ? rows : [rows]));
          const result = { data: { id: "log-1" }, error: null };
          return Object.assign(Promise.resolve({ error: null }), {
            select: () => ({ maybeSingle: async () => result }),
          });
        },
      };
      return chain;
    },
  } as never;
}

/** Twilio POSTs application/x-www-form-urlencoded. */
function twilioForm(fields: Record<string, string>) {
  return new URLSearchParams(fields);
}

/** Mirrors the log row the webhook handlers build from a Twilio payload. */
function webhookLogRow(form: URLSearchParams, actionType: string) {
  return {
    user_id: "tenant-1",
    customer_id: "cust-1",
    action_type: actionType,
    status: "received",
    message_sent: form.get("Body") ?? null,
    twilio_message_sid: form.get("MessageSid") ?? null,
    recipient_phone: form.get("From") ?? null,
    call_sid: form.get("CallSid") ?? null,
    recording_sid: form.get("RecordingSid") ?? null,
  };
}

const PAYLOADS: Array<{ name: string; form: URLSearchParams }> = [
  {
    name: "inbound SMS",
    form: twilioForm({
      From: "+15558675310",
      To: "+15017122661",
      Body: "hey are you available friday?",
      MessageSid: "SM11111111111111111111111111111111",
      AccountSid: "AC11111111111111111111111111111111",
    }),
  },
  {
    name: "STOP opt-out",
    form: twilioForm({
      From: "+15558675310",
      To: "+15017122661",
      Body: "STOP",
      MessageSid: "SM22222222222222222222222222222222",
    }),
  },
  {
    name: "YES opt-in",
    form: twilioForm({
      From: "+15558675310",
      To: "+15017122661",
      Body: "YES",
      MessageSid: "SM33333333333333333333333333333333",
    }),
  },
  {
    name: "missed call",
    form: twilioForm({
      From: "+15558675310",
      To: "+15017122661",
      CallSid: "CA44444444444444444444444444444444",
      CallStatus: "no-answer",
    }),
  },
  {
    name: "recording callback",
    form: twilioForm({
      From: "+15558675310",
      To: "+15017122661",
      CallSid: "CA55555555555555555555555555555555",
      RecordingSid: "RE55555555555555555555555555555555",
      RecordingUrl: "https://api.twilio.com/recordings/RE5555",
    }),
  },
];

/** Values a tampered payload or a regression could smuggle in. */
const INVALID_ACTION_TYPES = [
  "totally_made_up",
  "SMS_INBOUND", // wrong case — the DB check is case-sensitive
  " sms_inbound", // leading whitespace
  "sms_inbound; drop table logs",
  "",
];

describe("Twilio webhook payload with an invalid action_type", () => {
  beforeEach(() => {
    logInserts.length = 0;
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  for (const { name, form } of PAYLOADS) {
    for (const bad of INVALID_ACTION_TYPES) {
      it(`blocks ${name} with action_type ${JSON.stringify(bad)}`, async () => {
        const res = (await insertLog(fakeAdminClient(), webhookLogRow(form, bad) as never)) as unknown as {
          error: {
            code?: string;
            constraint?: string;
            message: string;
            hint?: string;
            rejectedActionType?: unknown;
          } | null;
        };

        expect(logInserts).toHaveLength(0); // never reached Postgres
        expect(res.error).toBeTruthy();
        expect(res.error?.code).toBe("23514");
        expect(res.error?.constraint).toBe(LOG_ACTION_TYPE_CONSTRAINT);
        expect(res.error?.hint).toBeTruthy();
        expect(res.error?.message).toContain(LOG_ACTION_TYPE_CONSTRAINT);
      });
    }
  }

  it("blocks consistently on the id-returning path used by the recording callback", async () => {
    const { form } = PAYLOADS[4]!;
    const res = (await insertLogReturningId(
      fakeAdminClient(),
      webhookLogRow(form, "voicemail_transcribed_v2") as never,
    )) as unknown as { id: string | null; error: { code?: string; constraint?: string } | null };

    expect(logInserts).toHaveLength(0);
    expect(res.id).toBeNull();
    expect(res.error?.code).toBe("23514");
    expect(res.error?.constraint).toBe(LOG_ACTION_TYPE_CONSTRAINT);
  });

  it("produces an identical error shape across every webhook branch", async () => {
    const shapes = new Set<string>();
    for (const { form } of PAYLOADS) {
      const res = (await insertLog(fakeAdminClient(), webhookLogRow(form, "nope_not_real") as never)) as unknown as {
        error: Record<string, unknown> | null;
      };
      const e = res.error!;
      shapes.add(JSON.stringify({ code: e['code'], constraint: e['constraint'], hint: e['hint'] }));
    }
    expect(shapes.size).toBe(1);
    expect(logInserts).toHaveLength(0);
  });

  it("still writes when the same payload carries a whitelisted action_type", async () => {
    const { form } = PAYLOADS[0]!;
    const res = await insertLog(fakeAdminClient(), webhookLogRow(form, LogAction.sms_inbound) as never);
    expect(res.error).toBeNull();
    expect(logInserts).toHaveLength(1);
    expect(logInserts[0]!['action_type']).toBe(LogAction.sms_inbound);
  });
});
