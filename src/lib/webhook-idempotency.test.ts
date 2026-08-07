import { describe, expect, it, vi } from "vitest";
import {
  claimWebhookDelivery,
  completeWebhookDelivery,
  duplicateResponse,
  twilioDeliveryKey,
} from "./webhook-idempotency.server";

const form = (o: Record<string, string>) => new URLSearchParams(o);

describe("twilioDeliveryKey", () => {
  it("keys voice deliveries by CallSid and call status", () => {
    expect(twilioDeliveryKey("missed_call", form({ CallSid: "CA1" }))).toBe("voice:CA1:ringing");
    expect(twilioDeliveryKey("missed_call", form({ CallSid: "CA1", CallStatus: "completed" }))).toBe(
      "voice:CA1:completed",
    );
  });

  it("keys inbound SMS by MessageSid, falling back to SmsSid", () => {
    expect(twilioDeliveryKey("sms_inbound", form({ MessageSid: "SM1" }))).toBe("sms:SM1");
    expect(twilioDeliveryKey("sms_inbound", form({ SmsSid: "SM2" }))).toBe("sms:SM2");
  });

  it("keys recording callbacks by RecordingSid and status", () => {
    expect(twilioDeliveryKey("recording_status", form({ RecordingSid: "RE1" }))).toBe(
      "recording:RE1:completed",
    );
  });

  it("returns null when the provider sent no stable id", () => {
    expect(twilioDeliveryKey("missed_call", form({}))).toBeNull();
    expect(twilioDeliveryKey("sms_inbound", form({}))).toBeNull();
  });
});

describe("claimWebhookDelivery", () => {
  it("processes normally when there is no dedupe key", async () => {
    const rpc = vi.fn();
    const claim = await claimWebhookDelivery({ rpc }, { source: "twilio", eventKind: "x", deliveryKey: null });
    expect(rpc).not.toHaveBeenCalled();
    expect(claim).toEqual({ deliveryId: null, duplicate: false, attemptCount: 1, storedResponse: null });
  });

  it("marks the first delivery as non-duplicate", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [{ delivery_id: "d1", is_duplicate: false, state: "processing", response_body: null, attempt_count: 1 }],
      error: null,
    });
    const claim = await claimWebhookDelivery({ rpc }, { source: "twilio", eventKind: "x", deliveryKey: "k" });
    expect(claim.duplicate).toBe(false);
    expect(claim.deliveryId).toBe("d1");
  });

  it("marks a retry as duplicate and exposes the stored response", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [
        {
          delivery_id: "d1",
          is_duplicate: true,
          state: "done",
          response_body: "<Response/>",
          response_content_type: "text/xml",
          response_status: 200,
          attempt_count: 2,
        },
      ],
      error: null,
    });
    const claim = await claimWebhookDelivery({ rpc }, { source: "twilio", eventKind: "x", deliveryKey: "k" });
    expect(claim.duplicate).toBe(true);
    expect(claim.attemptCount).toBe(2);
    expect(duplicateResponse(claim, "twiml").headers.get("Content-Type")).toBe("text/xml");
    expect(await duplicateResponse(claim, "twiml").text()).toBe("<Response/>");
  });

  it("fails open (processes) when the claim RPC errors", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } });
    const claim = await claimWebhookDelivery({ rpc }, { source: "twilio", eventKind: "x", deliveryKey: "k" });
    expect(claim.duplicate).toBe(false);
    expect(claim.deliveryId).toBeNull();
  });
});

describe("duplicateResponse without a stored response", () => {
  const inFlight = { deliveryId: "d1", duplicate: true, attemptCount: 2, storedResponse: null };

  it("returns inert 200 TwiML so Twilio stops retrying in-flight work", async () => {
    const res = duplicateResponse(inFlight, "twiml");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<Response/>");
  });

  it("returns inert 200 text for non-TwiML callbacks", async () => {
    const res = duplicateResponse(inFlight, "text");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });
});

describe("completeWebhookDelivery", () => {
  it("stores the response body and leaves the original readable", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    const original = new Response("<Response>hi</Response>", { headers: { "Content-Type": "text/xml" } });
    const returned = await completeWebhookDelivery({ rpc }, { deliveryId: "d1", userId: "u1", response: original });
    expect(rpc).toHaveBeenCalledWith("webhook_delivery_complete", expect.objectContaining({
      _delivery_id: "d1",
      _user_id: "u1",
      _state: "done",
      _response_body: "<Response>hi</Response>",
      _response_status: 200,
    }));
    expect(await returned.text()).toBe("<Response>hi</Response>");
  });

  it("is a no-op when there is no delivery id", async () => {
    const rpc = vi.fn();
    const res = new Response("ok");
    expect(await completeWebhookDelivery({ rpc }, { deliveryId: null, response: res })).toBe(res);
    expect(rpc).not.toHaveBeenCalled();
  });
});
