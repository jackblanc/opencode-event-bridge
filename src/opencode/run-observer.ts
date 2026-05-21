import * as Cloudflare from "alchemy/Cloudflare";
import { Schema } from "effect";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import { LinearHttpClient } from "../linear/client/client.ts";
import { makeOpenCodeClient } from "./client.ts";
import { openCodePrivateHost, openCodePrivatePort } from "./config.ts";
import { OpenCodeVpcService } from "./service.ts";

export const OpenCodeRunRecord = Schema.Struct({
  accessToken: Schema.String,
  linearAgentSessionId: Schema.String,
  linearIssueIdentifier: Schema.String,
  opencodeSessionId: Schema.String,
  opencodeWorkspaceDirectory: Schema.String,
});

export type OpenCodeRunRecord = Schema.Schema.Type<typeof OpenCodeRunRecord>;

export type OpenCodeRunObserverServiceShape = {
  readonly start: (run: OpenCodeRunRecord) => Effect.Effect<void>;
};

export class OpenCodeRunObserverService extends Context.Service<
  OpenCodeRunObserverService,
  OpenCodeRunObserverServiceShape
>()("app/OpenCodeRunObserver") {}

const runKey = "run";
const alarmDelayMillis = 1_000;

const detailFrom = (error: unknown) => {
  if (typeof error === "string") {
    return error;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return JSON.stringify(error);
};

export default class OpenCodeRunObserver extends Cloudflare.DurableObjectNamespace<OpenCodeRunObserver>()(
  "OpenCodeRunObserver",
  Effect.gen(function* () {
    const opencodeService = yield* OpenCodeVpcService.pipe(Effect.orDie);
    const bindVpcService = yield* Cloudflare.VpcServiceBinding;
    const opencodeBinding = yield* bindVpcService(opencodeService);
    const linear = yield* LinearHttpClient;

    const make = Effect.gen(function* () {
      const state = yield* Cloudflare.DurableObjectState;
      const env = yield* Cloudflare.WorkerEnvironment;

      const fetchOpenCode = async (input: string | URL | Request, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const url = new URL(request.url);
        url.protocol = "http:";
        url.hostname = openCodePrivateHost;
        url.port = openCodePrivatePort;
        const opencodeRequest = new Request(url, request);
        opencodeRequest.headers.set("host", url.host);
        const webResponse = await Effect.gen(function* () {
          const response = yield* opencodeBinding
            .fetch(HttpServerRequest.toClientRequest(HttpServerRequest.fromWeb(opencodeRequest)))
            .pipe(Effect.provideService(Cloudflare.WorkerEnvironment, env));

          const withoutBody =
            response.status === 101 ||
            response.status === 204 ||
            response.status === 205 ||
            response.status === 304;
          return HttpServerResponse.toWeb(HttpServerResponse.fromClientResponse(response), {
            withoutBody,
          });
        }).pipe(Effect.runPromise);

        return webResponse;
      };
      const opencode = makeOpenCodeClient(fetchOpenCode);

      const schedule = () => state.storage.setAlarm(Date.now() + alarmDelayMillis);

      const clear = () =>
        state.storage.delete(runKey).pipe(Effect.flatMap(() => state.storage.deleteAlarm()));

      const postError = (run: OpenCodeRunRecord, error: unknown) =>
        linear
          .createAgentActivity({
            accessToken: run.accessToken,
            agentSessionId: run.linearAgentSessionId,
            content: { body: detailFrom(error), type: "error" },
          })
          .pipe(
            Effect.tapError((cause) =>
              Effect.logError("opencode run observer error activity failed", {
                cause,
                issueIdentifier: run.linearIssueIdentifier,
                linearAgentSessionId: run.linearAgentSessionId,
                opencodeSessionId: run.opencodeSessionId,
                opencodeWorkspaceDirectory: run.opencodeWorkspaceDirectory,
              }),
            ),
            Effect.ignore,
          );

      const complete = (run: OpenCodeRunRecord) =>
        opencode
          .waitUntilIdle({
            sessionId: run.opencodeSessionId,
            workspaceDirectory: run.opencodeWorkspaceDirectory,
          })
          .pipe(
            Effect.flatMap(() =>
              opencode.completedResponse({
                sessionId: run.opencodeSessionId,
                workspaceDirectory: run.opencodeWorkspaceDirectory,
              }),
            ),
            Effect.flatMap((response) =>
              linear.createAgentActivity({
                accessToken: run.accessToken,
                agentSessionId: run.linearAgentSessionId,
                content: { body: response.body, type: "response" },
              }),
            ),
            Effect.flatMap(() => clear()),
            Effect.tap(() =>
              Effect.log("opencode run observer completed", {
                issueIdentifier: run.linearIssueIdentifier,
                linearAgentSessionId: run.linearAgentSessionId,
                opencodeSessionId: run.opencodeSessionId,
                opencodeWorkspaceDirectory: run.opencodeWorkspaceDirectory,
              }),
            ),
            Effect.catch((error) =>
              postError(run, error).pipe(
                Effect.flatMap(() => clear()),
                Effect.tap(() =>
                  Effect.logError("opencode run observer terminated", {
                    error: detailFrom(error),
                    issueIdentifier: run.linearIssueIdentifier,
                    linearAgentSessionId: run.linearAgentSessionId,
                    opencodeSessionId: run.opencodeSessionId,
                    opencodeWorkspaceDirectory: run.opencodeWorkspaceDirectory,
                  }),
                ),
              ),
            ),
          );

      const observe = Effect.gen(function* () {
        const stored = yield* state.storage.get<OpenCodeRunRecord>(runKey);
        const run = yield* Schema.decodeUnknownEffect(OpenCodeRunRecord)(stored).pipe(
          Effect.tapError((cause) =>
            Effect.logError("opencode run observer invalid run record", { cause }),
          ),
          Effect.option,
        );

        if (Option.isNone(run)) {
          yield* clear();
          return;
        }

        yield* complete(run.value).pipe(
          Effect.tapCause((cause) =>
            Effect.logError("opencode run observer alarm failed", {
              cause: Cause.pretty(cause),
              issueIdentifier: run.value.linearIssueIdentifier,
              linearAgentSessionId: run.value.linearAgentSessionId,
              opencodeSessionId: run.value.opencodeSessionId,
              opencodeWorkspaceDirectory: run.value.opencodeWorkspaceDirectory,
            }),
          ),
        );
      });

      return {
        alarm: () => observe,
        start: (run: OpenCodeRunRecord) =>
          Effect.gen(function* () {
            yield* state.storage.put(runKey, run);
            yield* schedule();
            yield* Effect.log("opencode run observer started", {
              issueIdentifier: run.linearIssueIdentifier,
              linearAgentSessionId: run.linearAgentSessionId,
              opencodeSessionId: run.opencodeSessionId,
              opencodeWorkspaceDirectory: run.opencodeWorkspaceDirectory,
            });
          }),
      };
    });

    return yield* Effect.succeed(make);
  }).pipe(
    Effect.provide([
      Cloudflare.VpcServiceBindingPolicyLive,
      Cloudflare.VpcServiceBindingLive,
      LinearHttpClient.layer,
    ]),
  ),
) {}

export const makeOpenCodeRunObserverService = (
  observers: Cloudflare.DurableObjectNamespace<OpenCodeRunObserver>,
): OpenCodeRunObserverServiceShape =>
  OpenCodeRunObserverService.of({
    start: (run) => observers.getByName(run.linearAgentSessionId).start(run),
  });
