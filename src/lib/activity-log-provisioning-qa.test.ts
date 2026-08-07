/**
 * Unit tests for the provisioning / opt-in-prompt Activity log QA audit.
 */
import { describe, expect, it } from "vitest";
import { LogAction } from "@/lib/log-action-types";
import {
  QA_AUDITED_ACTIONS,
  auditProvisioningLogs,
  formatQaReport,
} from "@/lib/activity-log-provisioning-qa";

const BIZ = { id: "biz-1", business_name: "Alpha Plumbing", provisioned: true };

describe("activity log provisioning QA audit", () => {
  it("passes on well-formed rows", () => {
    const report = auditProvisioningLogs(
      [
        { user_id: BIZ.id, action_type: LogAction.number_provisioned, status: "sent" },
        {
          user_id: BIZ.id,
          action_type: LogAction.opt_in_prompt,
          status: "delivered",
          recipient_phone: "+14155550123",
        },
        {
          user_id: BIZ.id,
          action_type: LogAction.opt_in_prompt_test,
          status: "failed",
          recipient_phone: "+14155550124",
        },
      ],
      [BIZ],
    );
    expect(report.ok, formatQaReport(report)).toBe(true);
    expect(report.totalRows).toBe(3);
    expect(report.businesses[0]!.counts[LogAction.opt_in_prompt]).toBe(1);
  });

  it("expects the documented Activity labels", () => {
    expect(QA_AUDITED_ACTIONS[LogAction.number_provisioned]).toBe("NUMBER_PROVISIONED");
    expect(QA_AUDITED_ACTIONS[LogAction.opt_in_prompt]).toBe("OPT_IN_PROMPT");
    expect(QA_AUDITED_ACTIONS[LogAction.opt_in_prompt_test]).toBe("OPT_IN_PROMPT_TEST");
  });

  it("flags a provisioned business with no provisioning entry", () => {
    const report = auditProvisioningLogs([], [BIZ]);
    expect(report.ok).toBe(false);
    expect(formatQaReport(report)).toContain("no number_provisioned entry");
  });

  it("flags unexpected statuses and missing recipients", () => {
    const report = auditProvisioningLogs(
      [
        { user_id: BIZ.id, action_type: LogAction.number_provisioned, status: "delivered" },
        { user_id: BIZ.id, action_type: LogAction.opt_in_prompt, status: "sent" },
      ],
      [BIZ],
    );
    expect(report.ok).toBe(false);
    const text = formatQaReport(report);
    expect(text).toContain('Unexpected status "delivered"');
    expect(text).toContain("missing recipient_phone");
  });

  it("flags orphan rows and rows the Activity log would drop", () => {
    const report = auditProvisioningLogs(
      [
        { user_id: null, action_type: LogAction.opt_in_prompt, status: "sent", recipient_phone: "+1415" },
        { user_id: BIZ.id, action_type: "not_a_real_action", status: "sent" },
        { user_id: BIZ.id, action_type: LogAction.number_provisioned, status: "sent" },
      ],
      [BIZ],
    );
    expect(report.ok).toBe(false);
    const text = formatQaReport(report);
    expect(text).toContain("no owning business");
    expect(text).toContain("cannot render");
    expect(report.droppedRowCount).toBe(1);
  });
});
