import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useValidatedLogInsert } from "./useValidatedLogInsert";
import { LogAction } from "@/lib/log-action-types";

function makeClient() {
  const insert = vi.fn().mockResolvedValue({ error: null });
  return {
    client: { from: vi.fn(() => ({ insert })) } as unknown as Parameters<
      typeof useValidatedLogInsert
    >[0],
    insert,
  };
}

describe("useValidatedLogInsert", () => {
  it("passes valid rows to the logs write API", async () => {
    const { client, insert } = makeClient();
    const { result } = renderHook(() => useValidatedLogInsert(client));
    const res = await result.current({
      user_id: "u",
      action_type: LogAction.status_refresh,
      status: "ok",
    });
    expect(insert).toHaveBeenCalledTimes(1);
    expect(res.error).toBeNull();
  });

  it("blocks an invalid action_type before calling the logs write API", async () => {
    const { client, insert } = makeClient();
    const { result } = renderHook(() => useValidatedLogInsert(client));
    const res = await result.current({
      user_id: "u",
      action_type: "not_a_real_action",
      status: "ok",
    } as never);
    expect(insert).not.toHaveBeenCalled();
    expect(res.error?.constraint).toBe("logs_action_type_check");
  });

  it("blocks arrays containing any invalid action_type", async () => {
    const { client, insert } = makeClient();
    const { result } = renderHook(() => useValidatedLogInsert(client));
    const res = await result.current([
      { user_id: "u", action_type: LogAction.status_refresh, status: "ok" },
      { user_id: "u", action_type: "bad_action", status: "ok" },
    ] as never);
    expect(insert).not.toHaveBeenCalled();
    expect(res.error?.constraint).toBe("logs_action_type_check");
  });
});
