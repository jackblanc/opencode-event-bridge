import * as Effect from "effect/Effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { LinearWebhookPayload } from "../../src/linear/webhook/payload.ts";

import {
  LinearWebhookBadRequest,
  LinearWebhookUnauthorized,
} from "../../src/linear/webhook/api.ts";
import { receiveLinearWebhook } from "../../src/linear/webhook/receive.ts";

const secret = "linear-webhook-secret";

const issuePayload = (): LinearWebhookPayload => ({
  action: "update",
  createdAt: "2026-05-14T00:00:00.000Z",
  data: {
    id: "issue-id",
    identifier: "OEB-1",
    state: {
      color: "#00ff00",
      id: "state-id",
      name: "Todo",
      type: "unstarted",
    },
  },
  organizationId: "org-id",
  type: "Issue",
  updatedFrom: null,
  url: "https://linear.app/example/issue/OEB-1",
  webhookId: "webhook-id",
  webhookTimestamp: Date.now(),
});

const bodyOf = (payload: LinearWebhookPayload) => {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
};

const sign = (raw: ArrayBuffer) =>
  Effect.promise(async () => {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { hash: "SHA-256", name: "HMAC" },
      false,
      ["sign"],
    );
    const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, raw));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  });

describe("receiveLinearWebhook", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("verifies and queues supported webhook events", async () => {
    vi.setSystemTime(new Date("2026-05-14T00:00:00.000Z"));
    const payload = issuePayload();
    const rawBody = bodyOf(payload);
    const signature = await Effect.runPromise(sign(rawBody));
    const sent: Array<LinearWebhookPayload> = [];

    const result = await Effect.runPromise(
      receiveLinearWebhook({
        event: "Issue",
        queue: {
          send: (message) => Effect.sync(() => sent.push(message)).pipe(Effect.asVoid),
        },
        rawBody,
        signature,
        webhookSecret: secret,
      }),
    );

    expect(result).toEqual({ queued: true });
    expect(sent).toEqual([payload]);
  });

  it("ignores unsupported signed events without decoding the payload", async () => {
    const rawBody = bodyOf(issuePayload());
    const signature = await Effect.runPromise(sign(rawBody));
    const sent: Array<LinearWebhookPayload> = [];

    const result = await Effect.runPromise(
      receiveLinearWebhook({
        event: "Reaction",
        queue: {
          send: (message) => Effect.sync(() => sent.push(message)).pipe(Effect.asVoid),
        },
        rawBody,
        signature,
        webhookSecret: secret,
      }),
    );

    expect(result).toEqual({ queued: false });
    expect(sent).toEqual([]);
  });

  it("rejects invalid signatures", async () => {
    const rawBody = bodyOf(issuePayload());

    const error = await Effect.runPromise(
      receiveLinearWebhook({
        event: "Issue",
        queue: { send: () => Effect.void },
        rawBody,
        signature: "00",
        webhookSecret: secret,
      }).pipe(Effect.flip),
    );

    expect(error).toBeInstanceOf(LinearWebhookUnauthorized);
    expect(error.reason).toBe("InvalidSignature");
  });

  it("rejects mismatched event headers", async () => {
    const rawBody = bodyOf(issuePayload());
    const signature = await Effect.runPromise(sign(rawBody));

    const error = await Effect.runPromise(
      receiveLinearWebhook({
        event: "AgentSessionEvent",
        queue: { send: () => Effect.void },
        rawBody,
        signature,
        webhookSecret: secret,
      }).pipe(Effect.flip),
    );

    expect(error).toBeInstanceOf(LinearWebhookBadRequest);
    expect(error.reason).toBe("EventMismatch");
  });

  it("rejects stale webhook timestamps", async () => {
    vi.setSystemTime(new Date("2026-05-14T00:00:00.000Z"));
    const payload = issuePayload();
    vi.setSystemTime(new Date("2026-05-14T00:02:01.000Z"));
    const rawBody = bodyOf(payload);
    const signature = await Effect.runPromise(sign(rawBody));

    const error = await Effect.runPromise(
      receiveLinearWebhook({
        event: "Issue",
        queue: { send: () => Effect.void },
        rawBody,
        signature,
        webhookSecret: secret,
      }).pipe(Effect.flip),
    );

    expect(error).toBeInstanceOf(LinearWebhookUnauthorized);
    expect(error.reason).toBe("StaleTimestamp");
  });
});
