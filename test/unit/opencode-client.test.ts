import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import { makeOpenCodeClient } from "../../src/opencode/client.ts";

const baseUrl = "http://127.0.0.1:4096";

const makeFetch =
  (handler: (request: Request) => Response): typeof fetch =>
  async (input, init) => {
    await Promise.resolve();
    return handler(input instanceof Request ? input : new Request(input, init));
  };

describe("OpenCodeClient", () => {
  it("does not subscribe when session status is already idle", async () => {
    const requests: Array<{ readonly method: string; readonly url: string }> = [];
    const client = makeOpenCodeClient(
      makeFetch((request) => {
        requests.push({ method: request.method, url: request.url });

        if (request.url === `${baseUrl}/session/status?directory=%2Ftmp%2Fwork`) {
          return Response.json({ "session-id": { type: "idle" } });
        }

        return new Response("unexpected request", { status: 500 });
      }),
      baseUrl,
    );

    await Effect.runPromise(
      client.waitUntilIdle({ sessionId: "session-id", workspaceDirectory: "/tmp/work" }),
    );

    expect(requests).toEqual([
      { method: "GET", url: `${baseUrl}/session/status?directory=%2Ftmp%2Fwork` },
    ]);
  });

  it("builds the final response from completed assistant text parts", async () => {
    const client = makeOpenCodeClient(
      makeFetch((request) => {
        if (request.url === `${baseUrl}/session/session-id/message?directory=%2Ftmp%2Fwork`) {
          return Response.json([
            {
              info: { id: "user-message-id", role: "user", time: { completed: 1 } },
              parts: [{ text: "ignore", type: "text" }],
            },
            {
              info: { id: "assistant-message-id", role: "assistant", time: { completed: 2 } },
              parts: [
                { text: "hello ", type: "text" },
                { text: "ignored", type: "tool" },
                { text: "world", type: "text" },
              ],
            },
          ]);
        }

        return new Response("unexpected request", { status: 500 });
      }),
      baseUrl,
    );

    const response = await Effect.runPromise(
      client.completedResponse({ sessionId: "session-id", workspaceDirectory: "/tmp/work" }),
    );

    expect(response).toEqual({ body: "hello world" });
  });
});
