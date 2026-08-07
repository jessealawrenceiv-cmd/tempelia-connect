/**
 * QA audit for provisioning / opt-in prompt activity-log entries.
 *
 * Confirms that `number_provisioned`, `opt_in_prompt` and `opt_in_prompt_test`
 * rows actually show up in the Activity log with the right label and a status
 * the UI understands — per business (user_id), not just globally.
 *
 * Pure logic here so it can be unit-tested; the live database version lives in
 * `activity-log-provisioning-qa.integration.test.ts`.
 */
import { LogAction, type LogActionType } from "@/lib/log-action-types";
import { LOG_ACTION_PRESENTATION } from "@/lib/log-action-presentation";
import { parseLogRowsResponse } from "@/lib/log-action-types.schema";

/** The action types this QA check covers, with their expected Activity labels. */
export const QA_AUDITED_ACTIONS = {
  [LogAction.number_provisioned]: "NUMBER_PROVISIONED",
  [LogAction.opt_in_prompt]: "OPT_IN_PROMPT",
  [LogAction.opt_in_prompt_test]: "OPT_IN_PROMPT_TEST",
} as const satisfies Partial<Record<LogActionType, string>>;

export type AuditedAction = keyof typeof QA_AUDITED_ACTIONS;

export const QA_AUDITED_ACTION_LIST = Object.keys(QA_AUDITED_ACTIONS) as AuditedAction[];

/**
 * Statuses each action is allowed to carry. Prompt sends start as sent/failed
 * and are later reconciled to the Twilio delivery status by the poller.
 */
const TWILIO_STATUSES = [
  "queued",
  "accepted",
  "scheduled",
  "sending",
  "sent",
  "delivered",
  "undelivered",
  "failed",
  "canceled",
] as const;

export const QA_ALLOWED_STATUSES: Record<AuditedAction, readonly string[]> = {
  [LogAction.number_provisioned]: ["sent"],
  [LogAction.opt_in_prompt]: TWILIO_STATUSES,
  [LogAction.opt_in_prompt_test]: TWILIO_STATUSES,
};

export type QaLogRow = {
  id?: string | null;
  user_id?: string | null;
  action_type: unknown;
  status?: unknown;
  recipient_phone?: string | null;
  created_at?: string | null;
};

export type QaBusiness = {
  id: string;
  business_name?: string | null;
  /** Business has a provisioned texting number, so a provisioning entry is expected. */
  provisioned?: boolean;
};

export type QaFinding = {
  level: "error" | "warning";
  businessId: string | null;
  actionType: string;
  message: string;
};

export type QaBusinessSummary = {
  businessId: string;
  businessName: string;
  counts: Record<AuditedAction, number>;
  statuses: Record<AuditedAction, string[]>;
};

export type QaReport = {
  ok: boolean;
  findings: QaFinding[];
  /** Rows the Activity log would drop entirely (unknown action_type). */
  droppedRowCount: number;
  businesses: QaBusinessSummary[];
  totalRows: number;
};

function emptyCounts(): Record<AuditedAction, number> {
  return {
    [LogAction.number_provisioned]: 0,
    [LogAction.opt_in_prompt]: 0,
    [LogAction.opt_in_prompt_test]: 0,
  };
}

function emptyStatuses(): Record<AuditedAction, string[]> {
  return {
    [LogAction.number_provisioned]: [],
    [LogAction.opt_in_prompt]: [],
    [LogAction.opt_in_prompt_test]: [],
  };
}

function isAudited(value: unknown): value is AuditedAction {
  return typeof value === "string" && value in QA_AUDITED_ACTIONS;
}

/**
 * Audits a set of log rows for the three provisioning / prompt action types.
 *
 * Errors mean the Activity log is wrong or unreadable (missing label, unknown
 * status, orphan row, dropped row). Warnings flag businesses whose state
 * implies an entry that is not on record.
 */
export function auditProvisioningLogs(rows: readonly QaLogRow[], businesses: readonly QaBusiness[]): QaReport {
  const findings: QaFinding[] = [];

  // Every audited action must have Activity presentation metadata with the
  // exact label this QA check (and the docs/screenshots) expect.
  for (const action of QA_AUDITED_ACTION_LIST) {
    const presentation = LOG_ACTION_PRESENTATION[action];
    if (!presentation) {
      findings.push({
        level: "error",
        businessId: null,
        actionType: action,
        message: `No Activity log presentation metadata for ${action} — rows would render with a fallback label.`,
      });
      continue;
    }
    const expected = QA_AUDITED_ACTIONS[action];
    if (presentation.label !== expected) {
      findings.push({
        level: "error",
        businessId: null,
        actionType: action,
        message: `Activity label for ${action} is "${presentation.label}", expected "${expected}".`,
      });
    }
    if (!presentation.dot) {
      findings.push({
        level: "error",
        businessId: null,
        actionType: action,
        message: `Activity status dot color missing for ${action}.`,
      });
    }
  }

  // Rows the Activity log read-path would silently drop.
  const parsed = parseLogRowsResponse(rows as readonly { action_type: unknown }[]);
  if (parsed.droppedCount > 0) {
    findings.push({
      level: "error",
      businessId: null,
      actionType: parsed.unknownActionTypes.join(", "),
      message: `${parsed.droppedCount} row(s) carry an action_type the Activity log cannot render and would be hidden.`,
    });
  }

  const byBusiness = new Map<string, QaBusinessSummary>();
  const ensure = (id: string) => {
    let entry = byBusiness.get(id);
    if (!entry) {
      const known = businesses.find((b) => b.id === id);
      entry = {
        businessId: id,
        businessName: known?.business_name?.trim() || "(unnamed business)",
        counts: emptyCounts(),
        statuses: emptyStatuses(),
      };
      byBusiness.set(id, entry);
    }
    return entry;
  };

  for (const business of businesses) ensure(business.id);

  let totalRows = 0;
  for (const row of rows) {
    if (!isAudited(row.action_type)) continue;
    totalRows += 1;
    const action = row.action_type;
    const businessId = typeof row.user_id === "string" && row.user_id ? row.user_id : null;

    if (!businessId) {
      findings.push({
        level: "error",
        businessId: null,
        actionType: action,
        message: `A ${action} entry has no owning business (user_id is null) — it cannot appear in any Activity log.`,
      });
      continue;
    }

    const summary = ensure(businessId);
    summary.counts[action] += 1;

    const status = typeof row.status === "string" ? row.status : "";
    if (!summary.statuses[action].includes(status)) summary.statuses[action].push(status);

    if (!status) {
      findings.push({
        level: "error",
        businessId,
        actionType: action,
        message: `A ${action} entry for ${summary.businessName} has an empty status.`,
      });
    } else if (!QA_ALLOWED_STATUSES[action].includes(status)) {
      findings.push({
        level: "error",
        businessId,
        actionType: action,
        message: `Unexpected status "${status}" on a ${action} entry for ${summary.businessName}. Allowed: ${QA_ALLOWED_STATUSES[action].join(", ")}.`,
      });
    }

    if (
      (action === LogAction.opt_in_prompt || action === LogAction.opt_in_prompt_test) &&
      !row.recipient_phone
    ) {
      findings.push({
        level: "error",
        businessId,
        actionType: action,
        message: `A ${action} entry for ${summary.businessName} is missing recipient_phone, so the Activity row cannot show who it went to.`,
      });
    }
  }

  // Coverage: a business with a provisioned number must have the entry on record.
  for (const business of businesses) {
    if (!business.provisioned) continue;
    const summary = ensure(business.id);
    if (summary.counts[LogAction.number_provisioned] === 0) {
      findings.push({
        level: "error",
        businessId: business.id,
        actionType: LogAction.number_provisioned,
        message: `${summary.businessName} has a provisioned texting number but no number_provisioned entry in the Activity log.`,
      });
    }
  }

  return {
    ok: findings.every((f) => f.level !== "error"),
    findings,
    droppedRowCount: parsed.droppedCount,
    businesses: [...byBusiness.values()].sort((a, b) => a.businessName.localeCompare(b.businessName)),
    totalRows,
  };
}

/** Human-readable report, used as the assertion message so failures explain themselves. */
export function formatQaReport(report: QaReport): string {
  const lines: string[] = [];
  lines.push(`Activity log QA — ${report.totalRows} audited row(s) across ${report.businesses.length} business(es)`);
  for (const business of report.businesses) {
    const parts = QA_AUDITED_ACTION_LIST.map((action) => {
      const count = business.counts[action];
      const statuses = business.statuses[action];
      return `${QA_AUDITED_ACTIONS[action]}=${count}${statuses.length ? ` [${statuses.join("/")}]` : ""}`;
    });
    lines.push(`  ${business.businessName}: ${parts.join("  ")}`);
  }
  for (const finding of report.findings) {
    lines.push(`  ${finding.level.toUpperCase()} · ${finding.actionType}: ${finding.message}`);
  }
  return lines.join("\n");
}
