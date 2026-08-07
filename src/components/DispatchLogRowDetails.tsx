/**
 * Expanded details for one Activity log row.
 *
 * Shows the raw dispatch payload (pretty-printed when it is JSON) plus the
 * related delivery/telephony fields that the one-line row can't fit. Payloads
 * from webhooks and status refreshes can run to dozens of keys, so a search box
 * narrows the payload to matching lines and highlights the hits.
 */

import { useId, useMemo, useState } from "react";
import { Copy, Search, X } from "lucide-react";
import { toast } from "sonner";


export type DispatchLogDetailRow = {
  id: string;
  action_type: string;
  status: string | null;
  message_sent: string | null;
  created_at: string;
  customer_id: string | null;
  recipient_phone?: string | null;
  twilio_message_sid?: string | null;
  voicemail_url?: string | null;
  recording_sid?: string | null;
  call_sid?: string | null;
  prompt_template?: string | null;
  prompt_template_hash?: string | null;
  prompt_cooldown_minutes?: number | null;
};

/** Pretty-prints the payload when it parses as JSON, otherwise returns it raw. */
export function formatDispatchPayload(message: string | null): { text: string; isJson: boolean } {
  if (!message) return { text: "—", isJson: false };
  try {
    return { text: JSON.stringify(JSON.parse(message), null, 2), isJson: true };
  } catch {
    return { text: message, isJson: false };
  }
}

/**
 * Case-insensitive, substring search over the payload's lines. Returns the
 * matching lines with their 1-based line numbers so the view can show where in
 * the payload each hit sits.
 */
export function searchPayloadLines(
  text: string,
  query: string,
): { line: number; content: string }[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return text
    .split("\n")
    .map((content, i) => ({ line: i + 1, content }))
    .filter((l) => l.content.toLowerCase().includes(q));
}

/** Renders `text` with every case-insensitive occurrence of `query` marked. */
const Highlight = ({ text, query }: { text: string; query: string }) => {
  const q = query.trim();
  if (!q) return <>{text}</>;
  const parts: React.ReactNode[] = [];
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  let cursor = 0;
  let at = lower.indexOf(needle);
  while (at !== -1) {
    if (at > cursor) parts.push(text.slice(cursor, at));
    parts.push(
      <mark key={`${at}`} className="rounded bg-primary/30 text-foreground">
        {text.slice(at, at + needle.length)}
      </mark>,
    );
    cursor = at + needle.length;
    at = lower.indexOf(needle, cursor);
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
};


const FieldRow = ({ label, value }: { label: string; value: string }) => (
  <div className="flex flex-col gap-0.5">
    <span className="text-[10px] uppercase tracking-widest text-muted-foreground">{label}</span>
    <span className="break-all font-mono text-xs text-foreground/90">{value}</span>
  </div>
);

export function DispatchLogRowDetails({ row }: { row: DispatchLogDetailRow }) {
  const payload = formatDispatchPayload(row.message_sent);
  const searchId = useId();
  const [query, setQuery] = useState("");
  const matches = useMemo(() => searchPayloadLines(payload.text, query), [payload.text, query]);


  const fields: { label: string; value: string | null | undefined }[] = [
    { label: "log id", value: row.id },
    { label: "action type", value: row.action_type },
    { label: "status", value: row.status },
    { label: "recorded at", value: new Date(row.created_at).toLocaleString() },
    { label: "contact id", value: row.customer_id },
    { label: "recipient", value: row.recipient_phone },
    { label: "message sid", value: row.twilio_message_sid },
    { label: "call sid", value: row.call_sid },
    { label: "recording sid", value: row.recording_sid },
    { label: "prompt hash", value: row.prompt_template_hash },
    {
      label: "cooldown",
      value:
        typeof row.prompt_cooldown_minutes === "number" ? `${row.prompt_cooldown_minutes} min` : null,
    },
  ];
  const shown = fields.filter((f) => f.value != null && f.value !== "");

  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${what} copied`);
    } catch {
      toast.error("Copy failed", { description: "Clipboard access was denied." });
    }
  };

  return (
    <div className="border-t border-border bg-muted/30 px-5 py-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {shown.map((f) => (
          <FieldRow key={f.label} label={f.label} value={String(f.value)} />
        ))}
      </div>

      {row.voicemail_url && (
        <div className="mt-4 flex flex-col gap-1.5">
          <span className="text-[10px] uppercase tracking-widest text-muted-foreground">voicemail</span>
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <audio controls preload="none" src={row.voicemail_url} className="w-full max-w-md" />
        </div>
      )}

      {row.prompt_template && (
        <div className="mt-4 flex flex-col gap-1.5">
          <span className="text-[10px] uppercase tracking-widest text-muted-foreground">prompt template</span>
          <p className="whitespace-pre-wrap rounded border border-border bg-background px-3 py-2 text-xs text-foreground/90">
            {row.prompt_template}
          </p>
        </div>
      )}

      <div className="mt-4 flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-3">
          <span className="text-[10px] uppercase tracking-widest text-muted-foreground">
            payload{payload.isJson ? " · json" : ""}
          </span>
          {row.message_sent && (
            <button
              type="button"
              onClick={() => void copy(payload.text, "Payload")}
              className="kb-focus inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-[10px] uppercase tracking-wider text-muted-foreground transition-colors hover:border-primary hover:text-primary"
            >
              <Copy size={11} aria-hidden="true" /> Copy payload
            </button>
          )}
        </div>

        {row.message_sent && (
          <div className="flex flex-col gap-1">
            <div className="relative">
              <Search
                size={12}
                aria-hidden="true"
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
              />
              <input
                id={searchId}
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape" && query) {
                    e.stopPropagation();
                    setQuery("");
                  }
                }}
                placeholder="Search payload fields…"
                aria-label="Search payload fields"
                aria-describedby={`${searchId}-count`}
                className="kb-focus w-full rounded border border-border bg-background py-1.5 pl-7 pr-8 font-mono text-[11px] text-foreground placeholder:text-muted-foreground"
              />
              {query && (
                <button
                  type="button"
                  aria-label="Clear payload search"
                  onClick={() => setQuery("")}
                  className="kb-focus absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  <X size={12} aria-hidden="true" />
                </button>
              )}
            </div>
            <span
              id={`${searchId}-count`}
              role="status"
              aria-live="polite"
              className="mono text-[10px] uppercase tracking-widest text-muted-foreground"
            >
              {query.trim()
                ? matches.length === 0
                  ? "No matching payload lines"
                  : `${matches.length} matching line${matches.length === 1 ? "" : "s"}`
                : ""}
            </span>
          </div>
        )}

        {query.trim() ? (
          matches.length === 0 ? (
            <p className="rounded border border-border bg-background px-3 py-2 font-mono text-[11px] text-muted-foreground">
              Nothing in this payload matches “{query.trim()}”.
            </p>
          ) : (
            <ul className="max-h-72 overflow-auto rounded border border-border bg-background px-3 py-2 font-mono text-[11px] leading-relaxed text-foreground/90">
              {matches.map((m) => (
                <li key={m.line} className="flex gap-3">
                  <span className="select-none text-right text-muted-foreground" style={{ minWidth: "2.5ch" }}>
                    {m.line}
                  </span>
                  <span className="whitespace-pre-wrap break-all">
                    <Highlight text={m.content.trimEnd()} query={query} />
                  </span>
                </li>
              ))}
            </ul>
          )
        ) : (
          <pre className="max-h-72 overflow-auto rounded border border-border bg-background px-3 py-2 font-mono text-[11px] leading-relaxed text-foreground/90">
            {payload.text}
          </pre>
        )}
      </div>

    </div>
  );
}
