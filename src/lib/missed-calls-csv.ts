/** CSV builder for the missed-calls dispatch export. */

export type MissedCallCsvRow = {
  created_at: string;
  from_number: string;
  to_number: string;
  customer_name: string;
  auto_reply_status: string;
  auto_reply_sid: string;
  call_sid: string;
  voicemail_url: string;
  recording_sid: string;
  opt_in_consent: string;
  /** Every opt-in prompt attempt for this contact, oldest first. */
  prompt_attempts: { created_at: string; status: string; twilio_message_sid: string | null }[];
};

const HEADERS = [
  "call_time_utc",
  "from_number",
  "to_number",
  "customer_name",
  "auto_reply_status",
  "auto_reply_twilio_sid",
  "call_sid",
  "voicemail_url",
  "recording_sid",
  "opt_in_consent",
  "opt_in_prompt_attempts",
  "opt_in_prompt_timestamps",
  "opt_in_prompt_sids",
];

function escapeCell(value: string): string {
  // Guard against spreadsheet formula injection on +1... phone numbers too.
  const safe = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function buildMissedCallsCsv(rows: MissedCallCsvRow[]): string {
  const lines = [HEADERS.join(",")];
  for (const row of rows) {
    const attempts = row.prompt_attempts;
    lines.push(
      [
        row.created_at,
        row.from_number,
        row.to_number,
        row.customer_name,
        row.auto_reply_status,
        row.auto_reply_sid,
        row.call_sid,
        row.voicemail_url,
        row.recording_sid,
        row.opt_in_consent,
        String(attempts.length),
        attempts.map((a) => `${a.created_at} (${a.status})`).join(" | "),
        attempts.map((a) => a.twilio_message_sid ?? "no-sid").join(" | "),
      ]
        .map((v) => escapeCell(v ?? ""))
        .join(","),
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}

export function downloadCsv(filename: string, csv: string) {
  const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
