import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { sendTestOptInPrompt, getTestSmsStatus } from "@/lib/opt-in-prompt.functions";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import {
  OPT_IN_PROMPT_TEST_ACTION,
  DEFAULT_OPT_IN_PROMPT_TEMPLATE,
  OPT_IN_PROMPT_COOLDOWN_MAX,
  OPT_IN_PROMPT_COOLDOWN_MIN,
  OPT_IN_PROMPT_COOLDOWN_MINUTES,
  OPT_IN_PROMPT_TEMPLATE_MAX_LENGTH,
  OPT_IN_PROMPT_COMPLIANCE_TEXT,
  buildOptInPrompt,
  clampCooldownMinutes,
  promptVersionHash,
  validateOptInPromptTemplate,
} from "@/lib/opt-in-prompt";

type Props = {
  businessName?: string | null;
  template?: string | null;
  cooldownMinutes?: number | null;
  ownerPhone?: string | null;
  fromNumber?: string | null;
};

/**
 * Owner-configurable lead-in and cooldown for the missed-call opt-in prompt.
 * The compliant YES-to-opt-in / STOP body is fixed and always appended.
 */
export function OptInPromptSettingsPanel({
  businessName,
  template,
  cooldownMinutes,
  ownerPhone,
  fromNumber,
}: Props) {
  const qc = useQueryClient();
  const sendTest = useServerFn(sendTestOptInPrompt);
  const checkStatus = useServerFn(getTestSmsStatus);
  const [lastTest, setLastTest] = useState<{
    to: string;
    sid: string;
    at: string;
    status: string;
    errorCode?: number | null;
    errorMessage?: string | null;
  } | null>(null);
  const [polling, setPolling] = useState(false);
  const [sampleName, setSampleName] = useState("Dana Reyes");
  const [samplePhone, setSamplePhone] = useState("+15015550123");
  const [testPhone, setTestPhone] = useState("");
  const [draft, setDraft] = useState("");
  const [cooldown, setCooldown] = useState(String(OPT_IN_PROMPT_COOLDOWN_MINUTES));

  const testHistory = useQuery({
    queryKey: ["opt-in-prompt-test-history"],
    queryFn: async () => {
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) return [];
      const { data, error } = await supabase
        .from("logs")
        .select("id, created_at, status, twilio_message_sid, prompt_cooldown_minutes, prompt_template_hash")
        .eq("user_id", u.user.id)
        .eq("action_type", OPT_IN_PROMPT_TEST_ACTION)
        .order("created_at", { ascending: false })
        .limit(10);
      if (error) throw error;
      return data ?? [];
    },
  });

  useEffect(() => {
    setTestPhone(ownerPhone ?? "");
  }, [ownerPhone]);

  useEffect(() => {
    setDraft(template ?? DEFAULT_OPT_IN_PROMPT_TEMPLATE);
  }, [template]);

  useEffect(() => {
    setCooldown(String(cooldownMinutes ?? OPT_IN_PROMPT_COOLDOWN_MINUTES));
  }, [cooldownMinutes]);

  const save = useMutation({
    mutationFn: async () => {
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) throw new Error("Not signed in");
      const trimmed = draft.trim();
      const blocking = validateOptInPromptTemplate(trimmed).filter((i) => i.level === "error");
      if (blocking.length > 0) throw new Error(blocking[0]!.message);
      const { error } = await supabase
        .from("profiles")
        .update({
          opt_in_prompt_template: trimmed || null,
          opt_in_prompt_cooldown_minutes: clampCooldownMinutes(cooldown),
        })
        .eq("id", u.user.id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Opt-in prompt settings saved.");
      qc.invalidateQueries({ queryKey: ["profile"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const TERMINAL = ["delivered", "undelivered", "failed", "canceled"];

  async function pollStatus(sid: string) {
    setPolling(true);
    try {
      for (let i = 0; i < 8; i++) {
        await new Promise((r) => setTimeout(r, i === 0 ? 1500 : 3000));
        try {
          const m = await checkStatus({ data: { sid } });
          setLastTest((prev) =>
            prev && prev.sid === sid
              ? { ...prev, status: m.status, errorCode: m.errorCode, errorMessage: m.errorMessage }
              : prev,
          );
          if (TERMINAL.includes(m.status)) break;
        } catch {
          break;
        }
      }
    } finally {
      setPolling(false);
    }
  }

  const test = useMutation({
    mutationFn: async () => await sendTest({ data: { phone: testPhone.trim() } }),
    onSuccess: (res) => {
      setLastTest({ to: res.to, sid: res.sid, at: new Date().toLocaleTimeString(), status: res.status });
      void pollStatus(res.sid);
      void qc.invalidateQueries({ queryKey: ["opt-in-prompt-test-history"] });
      toast.success(`Test prompt sent to ${res.to}`);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const issues = validateOptInPromptTemplate(draft);
  const hasError = issues.some((i) => i.level === "error");

  const preview = buildOptInPrompt(businessName ?? "", draft);

  return (
    <div className="panel p-6 md:col-span-2">
      <div className="label-eyebrow">Missed-call automation</div>
      <h2 className="mt-1 text-xl">Opt-in prompt & cooldown</h2>
      <p className="mt-2 text-xs text-muted-foreground">
        You control the lead-in only. The compliant YES-to-opt-in and STOP-to-unsubscribe language is
        always appended automatically and cannot be edited.
      </p>

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <label className="block">
          <span className="label-eyebrow">Lead-in template</span>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
            maxLength={OPT_IN_PROMPT_TEMPLATE_MAX_LENGTH}
            placeholder={DEFAULT_OPT_IN_PROMPT_TEMPLATE}
            className="mono mt-1 block w-full rounded-sm border border-border bg-background px-3 py-2 text-sm"
          />
          <span className="mono mt-1 block text-[10px] uppercase tracking-widest text-muted-foreground">
            {"{business}"} is replaced with your business name · {draft.length}/
            {OPT_IN_PROMPT_TEMPLATE_MAX_LENGTH}
          </span>
        </label>

        <label className="block">
          <span className="label-eyebrow">Cooldown between prompts (minutes)</span>
          <input
            type="number"
            min={OPT_IN_PROMPT_COOLDOWN_MIN}
            max={OPT_IN_PROMPT_COOLDOWN_MAX}
            value={cooldown}
            onChange={(e) => setCooldown(e.target.value)}
            className="mono mt-1 block w-full rounded-sm border border-border bg-background px-3 py-2 text-sm"
          />
          <span className="mono mt-1 block text-[10px] uppercase tracking-widest text-muted-foreground">
            {OPT_IN_PROMPT_COOLDOWN_MIN}–{OPT_IN_PROMPT_COOLDOWN_MAX} min · applied per contact on
            single and bulk sends
          </span>
        </label>
      </div>

      {issues.length > 0 && (
        <ul className="mt-4 space-y-1">
          {issues.map((i) => (
            <li
              key={i.message}
              className={`mono text-[11px] leading-relaxed ${
                i.level === "error" ? "text-destructive" : "text-primary"
              }`}
            >
              {i.level === "error" ? "✕" : "⚠"} {i.message}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 rounded-sm border border-border bg-background/60 p-3">
        <div className="label-eyebrow">Message preview</div>
        <p className="mono mt-2 text-xs leading-relaxed text-paper">{preview}</p>
        <p className="mono mt-2 text-[10px] uppercase tracking-widest text-muted-foreground">
          {preview.length} chars
        </p>
      </div>

      <div className="mt-4 rounded-sm border border-primary/40 bg-background/60 p-3">
        <div className="label-eyebrow text-primary">Preview for this customer</div>
        <p className="mt-1 text-xs text-muted-foreground">
          Enter a sample contact to see the exact message that leaves your Temaro number. The
          message body is identical for every contact — the lead-in supports only {"{business}"},
          so a customer name is never inserted into the text.
        </p>

        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <label className="block">
            <span className="label-eyebrow">Sample customer name</span>
            <input
              value={sampleName}
              onChange={(e) => setSampleName(e.target.value)}
              placeholder="Dana Reyes"
              className="mono mt-1 block w-full rounded-sm border border-border bg-background px-3 py-2 text-sm"
            />
          </label>
          <label className="block">
            <span className="label-eyebrow">Sample phone number</span>
            <input
              value={samplePhone}
              onChange={(e) => setSamplePhone(e.target.value)}
              placeholder="+15015550123"
              inputMode="tel"
              className="mono mt-1 block w-full rounded-sm border border-border bg-background px-3 py-2 text-sm"
            />
          </label>
        </div>

        <dl className="mono mt-3 space-y-1 text-[11px] uppercase tracking-widest text-muted-foreground">
          <div className="flex justify-between gap-3">
            <dt>To</dt>
            <dd className="text-paper">
              {samplePhone.trim() || "—"}
              {sampleName.trim() ? ` (${sampleName.trim()})` : ""}
            </dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt>From</dt>
            <dd className="text-paper">{fromNumber || "no Temaro number provisioned"}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt>Template version</dt>
            <dd className="text-paper">{promptVersionHash(preview)}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt>Cooldown</dt>
            <dd className="text-paper">{clampCooldownMinutes(cooldown)} min per contact</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt>Length / segments</dt>
            <dd className="text-paper">
              {preview.length} chars ·{" "}
              {preview.length <= 160 ? 1 : Math.ceil(preview.length / 153)} SMS
            </dd>
          </div>
        </dl>

        <div className="mt-3 rounded-sm border border-border bg-card p-3">
          <p className="mono text-xs leading-relaxed text-paper">
            {preview.slice(0, preview.length - OPT_IN_PROMPT_COMPLIANCE_TEXT.length)}
            <span className="text-moss">{OPT_IN_PROMPT_COMPLIANCE_TEXT}</span>
          </p>
        </div>
        <p className="mono mt-2 text-[10px] uppercase tracking-widest text-muted-foreground">
          Green text is the fixed YES-to-opt-in / STOP wording and cannot be edited
        </p>
      </div>

      <div className="mt-4 flex flex-wrap gap-3">
        <button
          type="button"
          onClick={() => save.mutate()}
          disabled={save.isPending || hasError}
          className="rounded-sm border border-border bg-card px-4 py-2 text-xs uppercase tracking-widest text-paper transition-colors hover:bg-muted disabled:opacity-50"
        >
          {save.isPending ? "Saving…" : "Save prompt settings"}
        </button>
        <button
          type="button"
          onClick={() => {
            setDraft(DEFAULT_OPT_IN_PROMPT_TEMPLATE);
            setCooldown(String(OPT_IN_PROMPT_COOLDOWN_MINUTES));
          }}
          className="rounded-sm border border-border px-4 py-2 text-xs uppercase tracking-widest text-muted-foreground transition-colors hover:text-paper"
        >
          Reset to default
        </button>
        <div className="flex flex-wrap items-center gap-2">
          <div>
            <input
              value={testPhone}
              onChange={(e) => setTestPhone(e.target.value)}
              placeholder={ownerPhone ?? "+15015550123"}
              inputMode="tel"
              maxLength={24}
              aria-label="Test phone number"
              aria-invalid={testPhoneError ? true : undefined}
              className={`mono w-48 rounded-sm border bg-background px-3 py-2 text-sm ${
                testPhoneError ? "border-destructive" : "border-border"
              }`}
            />
            <div className="mono mt-1 w-48 text-[10px] uppercase tracking-widest">
              {testPhoneError ? (
                <span className="text-destructive">{testPhoneError}</span>
              ) : testTarget ? (
                <span className="text-moss">Sends to {testTarget}</span>
              ) : (
                <span className="text-muted-foreground">10-digit US or E.164</span>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={() => test.mutate()}
            disabled={test.isPending || !testTarget}
            title={
              testPhoneError
                ? testPhoneError
                : testTarget
                  ? `Sends to ${testTarget}`
                  : "Enter a test number or add your owner mobile first"
            }
            className="rounded-sm border border-primary px-4 py-2 text-xs uppercase tracking-widest text-primary transition-colors hover:bg-primary/10 disabled:opacity-50"
          >
            {test.isPending ? "Sending…" : "Send test SMS"}
          </button>
          {ownerPhone && testPhone.trim() !== ownerPhone && (
            <button
              type="button"
              onClick={() => setTestPhone(ownerPhone)}
              className="mono text-[10px] uppercase tracking-widest text-muted-foreground underline"
            >
              Use owner mobile
            </button>
          )}
        </div>
      </div>

      <p className="mono mt-3 text-[10px] uppercase tracking-widest text-muted-foreground">
        {testPhone.trim()
          ? `Test goes to ${testPhone.trim()} · 10-digit US or E.164 · save first to test edits · same cooldown applies`
          : ownerPhone
            ? `Empty = owner mobile ${ownerPhone} · same cooldown applies`
            : "Enter a test number (or add an owner mobile above) to enable test sends"}
      </p>
      {lastTest && (
        <div className="mono mt-1 space-y-0.5 text-[10px] uppercase tracking-widest">
          <p className="text-moss">
            Sent {lastTest.at} → {lastTest.to} · SID {lastTest.sid}
          </p>
          <p>
            <span className="text-muted-foreground">Delivery status: </span>
            <span
              className={
                lastTest.status === "delivered"
                  ? "text-moss"
                  : lastTest.status === "failed" ||
                      lastTest.status === "undelivered" ||
                      lastTest.status === "canceled"
                    ? "text-destructive"
                    : "text-foreground"
              }
            >
              {lastTest.status}
            </span>
            {polling && !TERMINAL.includes(lastTest.status) ? (
              <span className="text-muted-foreground"> · checking…</span>
            ) : null}
            {!polling && !TERMINAL.includes(lastTest.status) ? (
              <button
                type="button"
                onClick={() => void pollStatus(lastTest.sid)}
                className="ml-2 underline text-muted-foreground hover:text-foreground"
              >
                Refresh
              </button>
            ) : null}
          </p>
          {(lastTest.errorCode || lastTest.errorMessage) && (
            <p className="text-destructive normal-case tracking-normal">
              Error {lastTest.errorCode ?? "—"}: {lastTest.errorMessage ?? "no detail returned"}
              {lastTest.errorCode ? (
                <>
                  {" "}
                  <a
                    className="underline"
                    href={`https://www.twilio.com/docs/api/errors/${lastTest.errorCode}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    docs
                  </a>
                </>
              ) : null}
            </p>
          )}
        </div>
      )}

      <div className="mt-6 border-t border-border pt-4">
        <div className="label-eyebrow">Test SMS history</div>
        <p className="mt-1 text-xs text-muted-foreground">
          Last 10 test sends from this account, newest first.
        </p>
        {testHistory.isLoading ? (
          <p className="mono mt-3 text-[10px] uppercase tracking-widest text-muted-foreground">
            Loading…
          </p>
        ) : (testHistory.data?.length ?? 0) === 0 ? (
          <p className="mono mt-3 text-[10px] uppercase tracking-widest text-muted-foreground">
            No test sends yet
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="mono w-full text-[11px]">
              <thead className="text-[10px] uppercase tracking-widest text-muted-foreground">
                <tr className="text-left">
                  <th className="py-1 pr-3 font-normal">Sent</th>
                  <th className="py-1 pr-3 font-normal">Result</th>
                  <th className="py-1 pr-3 font-normal">Twilio SID</th>
                  <th className="py-1 pr-3 font-normal">Version</th>
                  <th className="py-1 font-normal">Cooldown</th>
                </tr>
              </thead>
              <tbody>
                {testHistory.data!.map((row) => {
                  const mins = row.prompt_cooldown_minutes ?? OPT_IN_PROMPT_COOLDOWN_MINUTES;
                  const endsAt = new Date(new Date(row.created_at).getTime() + mins * 60_000);
                  const left = Math.ceil((endsAt.getTime() - Date.now()) / 60_000);
                  const blocking = left > 0;
                  return (
                    <tr key={row.id} className="border-t border-border/60 align-top">
                      <td className="py-1.5 pr-3 whitespace-nowrap">
                        {new Date(row.created_at).toLocaleString()}
                      </td>
                      <td
                        className={`py-1.5 pr-3 uppercase ${
                          row.status === "failed" ? "text-destructive" : "text-moss"
                        }`}
                      >
                        {row.status}
                      </td>
                      <td className="py-1.5 pr-3 break-all">{row.twilio_message_sid ?? "—"}</td>
                      <td className="py-1.5 pr-3">{row.prompt_template_hash ?? "—"}</td>
                      <td className="py-1.5 whitespace-nowrap">
                        {blocking ? (
                          <span className="text-primary">
                            {mins}m · blocking {left}m more
                          </span>
                        ) : (
                          <span className="text-muted-foreground">{mins}m · elapsed</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
