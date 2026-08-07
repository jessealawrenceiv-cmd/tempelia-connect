/**
 * Integration QA check: provisioning / opt-in-prompt entries in the Activity log.
 *
 * Reads the real `logs` table (plus the archive) with the service-role key so
 * RLS cannot hide rows, then audits every business that has — or should have —
 * `number_provisioned`, `opt_in_prompt` or `opt_in_prompt_test` entries:
 *
 *  - the action_type is renderable by the Activity log (known + labelled)
 *  - the status is one the UI expects for that action
 *  - prompt rows name their recipient
 *  - every business with a provisioned texting number has its entry on record
 *
 * Skipped automatically when service-role credentials are not present.
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  QA_AUDITED_ACTION_LIST,
  auditProvisioningLogs,
  formatQaReport,
  type QaBusiness,
  type QaLogRow,
  type QaReport,
} from "@/lib/activity-log-provisioning-qa";
import { LogAction } from "@/lib/log-action-types";

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const hasDb = Boolean(url && serviceKey);

async function rest<T>(path: string): Promise<T> {
  const res = await fetch(`${url}/rest/v1/${path}`, {
    headers: { apikey: serviceKey!, Authorization: `Bearer ${serviceKey}` },
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

const inList = `(${QA_AUDITED_ACTION_LIST.join(",")})`;

describe.skipIf(!hasDb)("QA: provisioning & opt-in prompt entries in the Activity log", () => {
  let report: QaReport;
  let archived: { action_type: string; status: string; user_id: string }[] = [];

  beforeAll(async () => {
    const [profiles, rows, archiveRows] = await Promise.all([
      rest<{ id: string; business_name: string | null; twilio_phone_sid: string | null }[]>(
        "profiles?select=id,business_name,twilio_phone_sid",
      ),
      rest<QaLogRow[]>(
        `logs?select=id,user_id,action_type,status,recipient_phone,created_at&action_type=in.${inList}&order=created_at.asc`,
      ),
      rest<{ action_type: string; status: string; user_id: string }[]>(
        `logs_archive?select=user_id,action_type,status&action_type=in.${inList}`,
      ),
    ]);

    archived = archiveRows;

    const businesses: QaBusiness[] = profiles.map((p) => ({
      id: p.id,
      business_name: p.business_name,
      provisioned: Boolean(p.twilio_phone_sid),
    }));

    // Archived rows still count as "on record" for coverage purposes.
    report = auditProvisioningLogs([...rows, ...archived] as QaLogRow[], businesses);
  });

  it("renders every audited entry with the correct label and status", () => {
    expect(report.ok, formatQaReport(report)).toBe(true);
  });

  it("hides no audited entry from the Activity log read path", () => {
    expect(report.droppedRowCount, formatQaReport(report)).toBe(0);
  });

  it("attributes every audited entry to a business", () => {
    const orphans = report.findings.filter((f) => f.message.includes("no owning business"));
    expect(orphans, formatQaReport(report)).toHaveLength(0);
  });

  it("has a number_provisioned entry for every business with a texting number", () => {
    const missing = report.findings.filter(
      (f) => f.actionType === LogAction.number_provisioned && f.message.includes("no number_provisioned entry"),
    );
    expect(missing, formatQaReport(report)).toHaveLength(0);
  });

  it("prints the per-business breakdown for review", () => {
    // Visible in test output; not an assertion on data volume, which varies.
    console.log(formatQaReport(report));
    expect(report.businesses.length).toBeGreaterThan(0);
  });
});
