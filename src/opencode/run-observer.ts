import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Schema } from "effect";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import type { LinearHttpClientService } from "../linear/client/client.ts";
import type { LinearOrgAuthStoreService } from "../linear/oauth/auth.ts";
import type { LinearSessionStoreService } from "../linear/session/store.ts";
import type { OpenCodeClientService } from "./client.ts";

import { LinearHttpClient } from "../linear/client/client.ts";
import { makeLinearOrgAuthStore } from "../linear/oauth/auth.ts";
import { LinearOrgAuthStore as LinearOrgAuthStoreResource } from "../linear/oauth/store.ts";
import { LinearSessionStoreKv } from "../linear/session/cloudflare.ts";
import { LinearSessionStore, makeLinearSessionStore } from "../linear/session/store.ts";
import { makeOpenCodeClient, OpenCodeClientError } from "./client.ts";
import { openCodePrivateHost, openCodePrivatePort } from "./config.ts";
import { processOpenCodeEvent } from "./events/process.ts";
import { OpenCodeVpcService } from "./service.ts";

export const OpenCodeRunRecord = Schema.Struct({
  linearAgentSessionId: Schema.String,
  opencodeSessionId: Schema.String,
  organizationId: Schema.String,
  projectDirectory: Schema.String,
  workspaceDirectory: Schema.String,
});

export type OpenCodeRunRecord = typeof OpenCodeRunRecord.Type;

export type OpenCodeRunObserverServiceShape = {
  readonly cancel: (input: { readonly linearAgentSessionId: string }) => Effect.Effect<void>;
  readonly start: (run: OpenCodeRunRecord) => Effect.Effect<void>;
};

export class OpenCodeRunObserverService extends Context.Service<
  OpenCodeRunObserverService,
  OpenCodeRunObserverServiceShape
>()("opencode-event-bridge/opencode/run-observer/OpenCodeRunObserverService") {}

const runKey = "run";
const alarmDelayMillis = 1_000;

const detailFrom = (error: unknown) => {
  if (typeof error === "string") {
    return error;
  }

  if (error instanceof Error) {
    if ("detail" in error && typeof error.detail === "string") {
      return error.detail;
    }

    return error.message;
  }

  return JSON.stringify(error);
};

export type OpenCodeRunObserverStorage = {
  readonly clear: () => Effect.Effect<void>;
  readonly get: () => Effect.Effect<unknown>;
  readonly put: (run: OpenCodeRunRecord) => Effect.Effect<void>;
  readonly schedule: () => Effect.Effect<void>;
};

export const makeOpenCodeRunObserverHandler = (input: {
  readonly authStore: LinearOrgAuthStoreService;
  readonly linear: LinearHttpClientService;
  readonly opencode: OpenCodeClientService;
  readonly state: OpenCodeRunObserverStorage;
  readonly store: LinearSessionStoreService;
}) => {
  const postError = (item: {
    readonly accessToken: string;
    readonly run: OpenCodeRunRecord;
    readonly error: unknown;
  }) =>
    input.linear
      .createAgentActivity({
        accessToken: item.accessToken,
        agentSessionId: item.run.linearAgentSessionId,
        content: { body: detailFrom(item.error), type: "error" },
      })
      .pipe(
        Effect.tapError((cause) =>
          Effect.logError("opencode run observer error activity failed", {
            cause,
            linearAgentSessionId: item.run.linearAgentSessionId,
            opencodeSessionId: item.run.opencodeSessionId,
            workspaceDirectory: item.run.workspaceDirectory,
          }),
        ),
        Effect.ignore,
      );

  const complete = (run: OpenCodeRunRecord) =>
    input.authStore.getOrgAuth({ organizationId: run.organizationId }).pipe(
      Effect.flatMap((orgAuth) =>
        input.opencode
          .waitUntilIdle({
            onEvent: (event, opencodeSessionIds) =>
              processOpenCodeEvent({
                event,
                run: {
                  accessToken: orgAuth.accessToken,
                  linearAgentSessionId: run.linearAgentSessionId,
                  opencodeSessionId: run.opencodeSessionId,
                  opencodeSessionIds,
                  organizationId: run.organizationId,
                },
              }).pipe(
                Effect.provideService(LinearHttpClient, input.linear),
                Effect.provideService(LinearSessionStore, input.store),
              ),
            requireStart: true,
            sessionId: run.opencodeSessionId,
            workspaceDirectory: run.workspaceDirectory,
          })
          .pipe(
            Effect.flatMap(() =>
              input.opencode.completedResponse({
                sessionId: run.opencodeSessionId,
                workspaceDirectory: run.workspaceDirectory,
              }),
            ),
            Effect.flatMap((response) =>
              input.linear.createAgentActivity({
                accessToken: orgAuth.accessToken,
                agentSessionId: run.linearAgentSessionId,
                content: { body: response.body, type: "response" },
              }),
            ),
            Effect.tap((activity) =>
              Effect.log("opencode run observer final response posted", {
                activityId: activity.id,
                linearAgentSessionId: run.linearAgentSessionId,
                opencodeSessionId: run.opencodeSessionId,
                workspaceDirectory: run.workspaceDirectory,
              }),
            ),
            Effect.flatMap(() => input.state.clear()),
            Effect.tap(() =>
              Effect.log("opencode run observer completed", {
                linearAgentSessionId: run.linearAgentSessionId,
                opencodeSessionId: run.opencodeSessionId,
                workspaceDirectory: run.workspaceDirectory,
              }),
            ),
            Effect.catch((error) => {
              if (Schema.is(OpenCodeClientError)(error) && error.reason === "InputPending") {
                return input.state.schedule().pipe(
                  Effect.tap(() =>
                    Effect.log("opencode run observer awaiting input", {
                      linearAgentSessionId: run.linearAgentSessionId,
                      opencodeSessionId: run.opencodeSessionId,
                      workspaceDirectory: run.workspaceDirectory,
                    }),
                  ),
                );
              }

              return postError({ accessToken: orgAuth.accessToken, error, run }).pipe(
                Effect.flatMap(() => input.state.clear()),
                Effect.tap(() =>
                  Effect.logError("opencode run observer terminated", {
                    error: detailFrom(error),
                    linearAgentSessionId: run.linearAgentSessionId,
                    opencodeSessionId: run.opencodeSessionId,
                    workspaceDirectory: run.workspaceDirectory,
                  }),
                ),
              );
            }),
          ),
      ),
      Effect.catch((error) =>
        input.state.schedule().pipe(
          Effect.tap(() =>
            Effect.logError("opencode run observer auth failed", {
              error: detailFrom(error),
              linearAgentSessionId: run.linearAgentSessionId,
              organizationId: run.organizationId,
            }),
          ),
        ),
      ),
    );

  const observe = Effect.gen(function* () {
    const stored = yield* input.state.get();
    const run = yield* Schema.decodeUnknownEffect(OpenCodeRunRecord)(stored).pipe(
      Effect.tapError((cause) =>
        Effect.logError("opencode run observer invalid run record", { cause }),
      ),
      Effect.option,
    );

    if (Option.isNone(run)) {
      yield* input.state.clear();
      return;
    }

    yield* complete(run.value).pipe(
      Effect.tapCause((cause) =>
        Effect.logError("opencode run observer alarm failed", {
          cause: Cause.pretty(cause),
          linearAgentSessionId: run.value.linearAgentSessionId,
          opencodeSessionId: run.value.opencodeSessionId,
          workspaceDirectory: run.value.workspaceDirectory,
        }),
      ),
    );
  });

  return {
    alarm: () => observe,
    cancel: () => input.state.clear(),
    start: (run: OpenCodeRunRecord) =>
      Effect.gen(function* () {
        yield* input.state.put(run);
        yield* input.state.schedule();
        yield* Effect.log("opencode run observer started", {
          linearAgentSessionId: run.linearAgentSessionId,
          opencodeSessionId: run.opencodeSessionId,
          workspaceDirectory: run.workspaceDirectory,
        });
      }),
  };
};

export default class OpenCodeRunObserver extends Cloudflare.DurableObject<OpenCodeRunObserver>()(
  "OpenCodeRunObserver",
  Effect.gen(function* () {
    const opencodeService = yield* OpenCodeVpcService.pipe(Effect.orDie);
    const bindVpcService = yield* Cloudflare.VpcService.VpcServiceBinding;
    const opencodeBinding = yield* bindVpcService(opencodeService);
    const sessionStoreResource = yield* LinearSessionStoreKv;
    const sessionStore = yield* Cloudflare.KV.ReadWriteNamespace(sessionStoreResource);
    const orgAuthResource = yield* LinearOrgAuthStoreResource;
    const orgAuthStore = yield* Cloudflare.KV.ReadWriteNamespace(orgAuthResource);
    const oauthClientId = yield* Config.redacted("LINEAR_OAUTH_CLIENT_ID").pipe(Effect.orDie);
    const oauthClientSecret = yield* Config.redacted("LINEAR_OAUTH_CLIENT_SECRET").pipe(
      Effect.orDie,
    );
    const linear = yield* LinearHttpClient;
    const env = yield* Cloudflare.WorkerEnvironment;

    const make = Effect.gen(function* () {
      const state = yield* Cloudflare.DurableObjectState;
      const ctx = yield* Alchemy.RuntimeContext;

      const fetchOpenCode = (input: string | URL | Request, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const url = new URL(request.url);
        url.protocol = "http:";
        url.hostname = openCodePrivateHost;
        url.port = openCodePrivatePort;
        const opencodeRequest = new Request(url, request);
        opencodeRequest.headers.set("host", url.host);
        return Effect.gen(function* () {
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
      };
      const opencode = makeOpenCodeClient({ fetch: fetchOpenCode });
      const store = makeLinearSessionStore({
        delete: (key) =>
          sessionStore
            .delete(key)
            .pipe(
              Effect.provideService(Alchemy.RuntimeContext, ctx),
              Effect.provideService(Cloudflare.WorkerEnvironment, env),
            ),
        get: (key) =>
          sessionStore
            .get(key)
            .pipe(
              Effect.provideService(Alchemy.RuntimeContext, ctx),
              Effect.provideService(Cloudflare.WorkerEnvironment, env),
            ),
        put: (key, value) =>
          sessionStore
            .put(key, value)
            .pipe(
              Effect.provideService(Alchemy.RuntimeContext, ctx),
              Effect.provideService(Cloudflare.WorkerEnvironment, env),
            ),
      });
      const authStore = makeLinearOrgAuthStore({
        kv: {
          get: (key) =>
            orgAuthStore
              .get(key)
              .pipe(
                Effect.provideService(Alchemy.RuntimeContext, ctx),
                Effect.provideService(Cloudflare.WorkerEnvironment, env),
              ),
          put: (key, value) =>
            orgAuthStore
              .put(key, value)
              .pipe(
                Effect.provideService(Alchemy.RuntimeContext, ctx),
                Effect.provideService(Cloudflare.WorkerEnvironment, env),
              ),
        },
        refresh: (record) =>
          Effect.gen(function* () {
            const token = yield* linear.refreshOAuthToken({
              clientId: Redacted.value(oauthClientId),
              clientSecret: Redacted.value(oauthClientSecret),
              refreshToken: record.refreshToken,
            });
            const now = yield* Clock.currentTimeMillis;

            return {
              ...record,
              accessToken: token.access_token,
              accessTokenExpiresAt: now + token.expires_in * 1_000,
              refreshToken: token.refresh_token,
            };
          }),
      });

      return makeOpenCodeRunObserverHandler({
        authStore,
        linear,
        opencode,
        state: {
          clear: () =>
            state.storage.delete(runKey).pipe(
              Effect.flatMap(() => state.storage.deleteAlarm()),
              Effect.provideService(Alchemy.RuntimeContext, ctx),
            ),
          get: () =>
            state.storage.get(runKey).pipe(Effect.provideService(Alchemy.RuntimeContext, ctx)),
          put: (run) =>
            state.storage.put(runKey, run).pipe(Effect.provideService(Alchemy.RuntimeContext, ctx)),
          schedule: () =>
            Effect.gen(function* () {
              const now = yield* Clock.currentTimeMillis;
              yield* state.storage.setAlarm(now + alarmDelayMillis);
            }).pipe(Effect.provideService(Alchemy.RuntimeContext, ctx)),
        },
        store,
      });
    });

    return yield* Effect.succeed(make);
  }).pipe(
    Effect.provide([
      Cloudflare.VpcService.VpcServiceBindingLive,
      Cloudflare.KV.ReadWriteNamespaceBinding,
      LinearHttpClient.layer,
    ]),
  ),
) {}

export const makeOpenCodeRunObserverService = (
  observers: Cloudflare.DurableObject<OpenCodeRunObserver>,
): OpenCodeRunObserverServiceShape =>
  OpenCodeRunObserverService.of({
    cancel: (input) => observers.getByName(input.linearAgentSessionId).cancel(),
    start: (run) => observers.getByName(run.linearAgentSessionId).start(run),
  });
