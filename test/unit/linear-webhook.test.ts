import { beforeEach, describeWrapped, expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { TestClock } from "effect/testing";

import type { LinearWebhookPayload } from "../../src/linear/webhook/payload.ts";

import {
  LinearWebhookBadRequest,
  LinearWebhookUnauthorized,
} from "../../src/linear/webhook/api.ts";
import { receiveLinearWebhook } from "../../src/linear/webhook/receive.ts";
import { decodeLinearWebhookQueueMessage } from "../../src/workers/linear-webhook-processor.ts";

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
  webhookTimestamp: 0,
});

const bodyOf = (payload: LinearWebhookPayload) => {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
};

const sign = (raw: ArrayBuffer) =>
  Effect.gen(function* () {
    const key = yield* Effect.promise(() =>
      crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        { hash: "SHA-256", name: "HMAC" },
        false,
        ["sign"],
      ),
    );
    const signed = yield* Effect.promise(() => crypto.subtle.sign("HMAC", key, raw));
    const bytes = new Uint8Array(signed);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  });

describeWrapped("receiveLinearWebhook", (it) => {
  it.effect("verifies and queues supported webhook events", () =>
    Effect.gen(function* () {
      const payload = issuePayload();
      const rawBody = bodyOf(payload);
      const signature = yield* sign(rawBody);
      const sent: Array<LinearWebhookPayload> = [];

      const result = yield* receiveLinearWebhook({
        allowedOrganizationId: "org-id",
        event: "Issue",
        queue: {
          send: (message) => Effect.sync(() => sent.push(message)).pipe(Effect.asVoid),
        },
        rawBody,
        signature,
        webhookSecret: secret,
      });

      expect(result).toEqual({ queued: true });
      expect(sent).toEqual([payload]);
    }),
  );

  it.effect("ignores unsupported signed events without decoding the payload", () =>
    Effect.gen(function* () {
      const rawBody = bodyOf(issuePayload());
      const signature = yield* sign(rawBody);
      const sent: Array<LinearWebhookPayload> = [];

      const result = yield* receiveLinearWebhook({
        allowedOrganizationId: "org-id",
        event: "Reaction",
        queue: {
          send: (message) => Effect.sync(() => sent.push(message)).pipe(Effect.asVoid),
        },
        rawBody,
        signature,
        webhookSecret: secret,
      });

      expect(result).toEqual({ queued: false });
      expect(sent).toEqual([]);
    }),
  );

  it.effect("rejects invalid signatures", () =>
    Effect.gen(function* () {
      const rawBody = bodyOf(issuePayload());

      const error = yield* receiveLinearWebhook({
        allowedOrganizationId: "org-id",
        event: "Issue",
        queue: { send: () => Effect.void },
        rawBody,
        signature: "00",
        webhookSecret: secret,
      }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(LinearWebhookUnauthorized);
      expect(error.reason).toBe("InvalidSignature");
    }),
  );

  it.effect("rejects signed webhook payloads from other organizations", () =>
    Effect.gen(function* () {
      const payload: LinearWebhookPayload = { ...issuePayload(), organizationId: "other-org-id" };
      const rawBody = bodyOf(payload);
      const signature = yield* sign(rawBody);
      const sent: Array<LinearWebhookPayload> = [];

      const error = yield* receiveLinearWebhook({
        allowedOrganizationId: "org-id",
        event: "Issue",
        queue: {
          send: (message) => Effect.sync(() => sent.push(message)).pipe(Effect.asVoid),
        },
        rawBody,
        signature,
        webhookSecret: secret,
      }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(LinearWebhookUnauthorized);
      expect(error.reason).toBe("OrganizationNotAllowed");
      expect(sent).toEqual([]);
    }),
  );

  it.effect("preserves invalid payload decode cause", () =>
    Effect.gen(function* () {
      const serialized = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)({
        type: "Issue",
      });
      const bytes = new TextEncoder().encode(serialized);
      const rawBody = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      const signature = yield* sign(rawBody);

      const error = yield* receiveLinearWebhook({
        allowedOrganizationId: "org-id",
        event: "Issue",
        queue: { send: () => Effect.void },
        rawBody,
        signature,
        webhookSecret: secret,
      }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(LinearWebhookBadRequest);
      expect(error.reason).toBe("InvalidPayload");
      expect(String(error.cause)).toContain("createdAt");
    }),
  );

  it.effect("rejects mismatched event headers", () =>
    Effect.gen(function* () {
      const rawBody = bodyOf(issuePayload());
      const signature = yield* sign(rawBody);

      const error = yield* receiveLinearWebhook({
        allowedOrganizationId: "org-id",
        event: "AgentSessionEvent",
        queue: { send: () => Effect.void },
        rawBody,
        signature,
        webhookSecret: secret,
      }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(LinearWebhookBadRequest);
      expect(error.reason).toBe("EventMismatch");
    }),
  );

  it.effect("rejects stale webhook timestamps", () =>
    Effect.gen(function* () {
      const payload = issuePayload();
      yield* TestClock.adjust(121_000);
      const rawBody = bodyOf(payload);
      const signature = yield* sign(rawBody);

      const error = yield* receiveLinearWebhook({
        allowedOrganizationId: "org-id",
        event: "Issue",
        queue: { send: () => Effect.void },
        rawBody,
        signature,
        webhookSecret: secret,
      }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(LinearWebhookUnauthorized);
      expect(error.reason).toBe("StaleTimestamp");
    }),
  );
});

const logs: Array<unknown> = [];
const logger = Logger.make<unknown, void>((options) => {
  logs.push(options.message);
});

beforeEach(() => {
  logs.length = 0;
});

layer(Logger.layer([logger]))("decodeLinearWebhookQueueMessage", (it) => {
  it.effect("logs invalid queue payload with decode cause and message id", () =>
    Effect.gen(function* () {
      const result = yield* decodeLinearWebhookQueueMessage({
        body: { type: "AgentSessionEvent" },
        messageId: "msg-id",
      });

      expect(Option.isNone(result)).toBe(true);
      const rendered = logs.map((log) => JSON.stringify(log)).join("\n");

      expect(rendered).toContain("invalid linear webhook queue message");
      expect(rendered).toContain("msg-id");
      expect(rendered).toContain("webhookId");
    }),
  );
});
