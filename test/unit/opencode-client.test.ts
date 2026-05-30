import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import { makeOpenCodeClient } from "../../src/opencode/client.ts";

const baseUrl = "http://127.0.0.1:4096";

const makeFetch =
  (handler: (request: Request) => Response | Promise<Response>): typeof fetch =>
  async (input, init) => {
    await Promise.resolve();
    return handler(input instanceof Request ? input : new Request(input, init));
  };

describe("OpenCodeClient", () => {
  it("aborts sessions with workspace routing", async () => {
    const requests: Array<{
      readonly body: string;
      readonly contentType: string | null;
      readonly method: string;
      readonly url: string;
    }> = [];
    const client = makeOpenCodeClient(
      makeFetch(async (request) => {
        requests.push({
          body: await request.text(),
          contentType: request.headers.get("content-type"),
          method: request.method,
          url: request.url,
        });

        if (request.url === `${baseUrl}/session/session-id/abort?directory=%2Ftmp%2Fwork`) {
          return Response.json(true);
        }

        return new Response("unexpected request", { status: 500 });
      }),
      baseUrl,
    );

    await Effect.runPromise(
      client.abortSession({ sessionId: "session-id", workspaceDirectory: "/tmp/work" }),
    );

    expect(requests).toEqual([
      {
        body: "{}",
        contentType: "application/json",
        method: "POST",
        url: `${baseUrl}/session/session-id/abort?directory=%2Ftmp%2Fwork`,
      },
    ]);
  });

  it("does not subscribe when session status is already idle", async () => {
    const requests: Array<{ readonly method: string; readonly url: string }> = [];
    const client = makeOpenCodeClient(
      makeFetch((request) => {
        requests.push({ method: request.method, url: request.url });

        if (request.url === `${baseUrl}/session/session-id/children?directory=%2Ftmp%2Fwork`) {
          return Response.json([]);
        }

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
      { method: "GET", url: `${baseUrl}/session/session-id/children?directory=%2Ftmp%2Fwork` },
      { method: "GET", url: `${baseUrl}/session/status?directory=%2Ftmp%2Fwork` },
    ]);
  });

  it("waits for a required run start before accepting idle", async () => {
    const requests: Array<{ readonly method: string; readonly url: string }> = [];
    const statuses: Array<string> = [];
    const client = makeOpenCodeClient(
      makeFetch((request) => {
        requests.push({ method: request.method, url: request.url });

        if (request.url === `${baseUrl}/session/session-id/children?directory=%2Ftmp%2Fwork`) {
          return Response.json([]);
        }

        if (request.url === `${baseUrl}/permission?directory=%2Ftmp%2Fwork`) {
          return Response.json([]);
        }

        if (request.url === `${baseUrl}/question?directory=%2Ftmp%2Fwork`) {
          return Response.json([]);
        }

        if (request.url === `${baseUrl}/event?directory=%2Ftmp%2Fwork`) {
          return new Response("", { headers: { "content-type": "text/event-stream" } });
        }

        if (request.url === `${baseUrl}/session/status?directory=%2Ftmp%2Fwork`) {
          const status = statuses.length === 0 ? "idle" : statuses.length === 1 ? "busy" : "idle";
          statuses.push(status);
          return Response.json({ "session-id": { type: status } });
        }

        return new Response("unexpected request", { status: 500 });
      }),
      baseUrl,
    );

    await Effect.runPromise(
      client.waitUntilIdle({
        requireStart: true,
        sessionId: "session-id",
        workspaceDirectory: "/tmp/work",
      }),
    );

    expect(statuses).toEqual(["idle", "busy", "idle"]);
    expect(requests).toContainEqual({
      method: "GET",
      url: `${baseUrl}/event?directory=%2Ftmp%2Fwork`,
    });
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
