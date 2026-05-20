import { Context, Effect, Layer, Schema } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

import { LinearOAuthTokenResponse, LinearViewerGraphqlResponse } from "../oauth/schema.ts";

const linearApiUrl = "https://api.linear.app";
const linearOAuthTokenPath = "/oauth/token";
const linearGraphqlPath = "/graphql";

const LinearAgentActivityContent = Schema.Union([
  Schema.Struct({
    body: Schema.String,
    type: Schema.Literal("thought"),
  }),
  Schema.Struct({
    body: Schema.String,
    type: Schema.Literal("response"),
  }),
  Schema.Struct({
    body: Schema.String,
    type: Schema.Literal("error"),
  }),
  Schema.Struct({
    action: Schema.String,
    parameter: Schema.String,
    result: Schema.optional(Schema.String),
    type: Schema.Literal("action"),
  }),
]);

export type LinearAgentActivityContent = Schema.Schema.Type<typeof LinearAgentActivityContent>;

const LinearAgentActivityCreateGraphqlResponse = Schema.Struct({
  data: Schema.Struct({
    agentActivityCreate: Schema.Struct({
      success: Schema.Boolean,
      agentActivity: Schema.Struct({
        id: Schema.String,
      }),
    }),
  }),
  errors: Schema.optionalKey(Schema.Never),
  extensions: Schema.optionalKey(Schema.Unknown),
});

const LinearAgentSessionUpdateGraphqlResponse = Schema.Struct({
  data: Schema.Struct({
    agentSessionUpdate: Schema.Struct({
      success: Schema.Boolean,
    }),
  }),
  errors: Schema.optionalKey(Schema.Never),
  extensions: Schema.optionalKey(Schema.Unknown),
});

const LinearIssueLabelsGraphqlResponse = Schema.Struct({
  data: Schema.Struct({
    issue: Schema.Struct({
      labels: Schema.Struct({
        nodes: Schema.Array(
          Schema.Struct({
            name: Schema.String,
            parent: Schema.NullOr(
              Schema.Struct({
                name: Schema.String,
              }),
            ),
          }),
        ),
      }),
    }),
  }),
  errors: Schema.optionalKey(Schema.Never),
  extensions: Schema.optionalKey(Schema.Unknown),
});

export type LinearHttpClientService = {
  createAgentActivity(input: {
    readonly accessToken: string;
    readonly agentSessionId: string;
    readonly content: LinearAgentActivityContent;
  }): Effect.Effect<void, LinearHttpClientError>;
  exchangeOAuthCode(input: {
    readonly clientId: string;
    readonly clientSecret: string;
    readonly code: string;
    readonly redirectUri: string;
  }): Effect.Effect<typeof LinearOAuthTokenResponse.Type, LinearHttpClientError>;
  fetchViewer(
    accessToken: string,
  ): Effect.Effect<typeof LinearViewerGraphqlResponse.Type, LinearHttpClientError>;
  getIssueLabels(input: {
    readonly accessToken: string;
    readonly issueId: string;
  }): Effect.Effect<
    ReadonlyArray<{ readonly name: string; readonly parent: { readonly name: string } | null }>,
    LinearHttpClientError
  >;
  updateAgentSessionExternalUrls(input: {
    readonly accessToken: string;
    readonly agentSessionId: string;
    readonly externalUrls: ReadonlyArray<{ readonly label: string; readonly url: string }>;
  }): Effect.Effect<void, LinearHttpClientError>;
};

export class LinearHttpClient extends Context.Service<LinearHttpClient, LinearHttpClientService>()(
  "app/LinearHttpClient",
) {
  static readonly layer = Layer.effect(
    LinearHttpClient,
    Effect.gen(function* () {
      const client = (yield* HttpClient.HttpClient).pipe(
        HttpClient.mapRequest(HttpClientRequest.prependUrl(linearApiUrl)),
        HttpClient.mapRequest(HttpClientRequest.acceptJson),
        HttpClient.filterStatusOk,
      );

      const executeGraphql = (accessToken: string, query: string, variables: unknown) =>
        Effect.gen(function* () {
          const request = yield* HttpClientRequest.post(linearGraphqlPath).pipe(
            HttpClientRequest.setHeader("authorization", `Bearer ${accessToken}`),
            HttpClientRequest.bodyJson({ query, variables }),
            Effect.mapError(
              (cause) => new LinearHttpClientError({ cause, reason: "InvalidGraphqlRequest" }),
            ),
          );

          return yield* client
            .execute(request)
            .pipe(
              Effect.mapError((cause) => new LinearHttpClientError({ cause, reason: "HttpError" })),
            );
        });

      const decodeGraphql =
        <S extends Schema.Top>(schema: S) =>
        (response: HttpClientResponse.HttpClientResponse) =>
          HttpClientResponse.schemaBodyJson(schema)(response).pipe(
            Effect.mapError(
              (cause) => new LinearHttpClientError({ cause, reason: "InvalidGraphqlResponse" }),
            ),
          );

      const createAgentActivity = Effect.fn("LinearHttpClient.createAgentActivity")(
        function* (input: {
          readonly accessToken: string;
          readonly agentSessionId: string;
          readonly content: LinearAgentActivityContent;
        }) {
          const response = yield* executeGraphql(
            input.accessToken,
            `mutation AgentActivityCreate($input: AgentActivityCreateInput!) {
            agentActivityCreate(input: $input) {
              success
              agentActivity { id }
            }
          }`,
            {
              input: {
                agentSessionId: input.agentSessionId,
                content: input.content,
              },
            },
          );
          const result = yield* decodeGraphql(LinearAgentActivityCreateGraphqlResponse)(response);

          if (!result.data.agentActivityCreate.success) {
            return yield* new LinearHttpClientError({
              cause: "agentActivityCreate returned success=false",
              reason: "InvalidGraphqlResponse",
            });
          }

          return undefined;
        },
      );

      const exchangeOAuthCode = Effect.fn("LinearHttpClient.exchangeOAuthCode")(function* (input: {
        readonly clientId: string;
        readonly clientSecret: string;
        readonly code: string;
        readonly redirectUri: string;
      }) {
        yield* Effect.annotateCurrentSpan({ redirectUri: input.redirectUri });

        return yield* HttpClientRequest.post(linearOAuthTokenPath).pipe(
          HttpClientRequest.bodyUrlParams({
            client_id: input.clientId,
            client_secret: input.clientSecret,
            code: input.code,
            grant_type: "authorization_code",
            redirect_uri: input.redirectUri,
          }),
          client.execute,
          Effect.flatMap(HttpClientResponse.schemaBodyJson(LinearOAuthTokenResponse)),
          Effect.mapError((cause) => new LinearHttpClientError({ cause, reason: "HttpError" })),
        );
      });

      const fetchViewer = Effect.fn("LinearHttpClient.fetchViewer")(function* (
        accessToken: string,
      ) {
        const response = yield* executeGraphql(
          accessToken,
          "query Viewer { viewer { id organization { id name } } }",
          {},
        );

        return yield* decodeGraphql(LinearViewerGraphqlResponse)(response);
      });

      const getIssueLabels = Effect.fn("LinearHttpClient.getIssueLabels")(function* (input: {
        readonly accessToken: string;
        readonly issueId: string;
      }) {
        const response = yield* executeGraphql(
          input.accessToken,
          `query IssueLabels($id: String!) {
            issue(id: $id) {
              labels {
                nodes {
                  name
                  parent { name }
                }
              }
            }
          }`,
          { id: input.issueId },
        );
        const result = yield* decodeGraphql(LinearIssueLabelsGraphqlResponse)(response);

        return result.data.issue.labels.nodes;
      });

      const updateAgentSessionExternalUrls = Effect.fn(
        "LinearHttpClient.updateAgentSessionExternalUrls",
      )(function* (input: {
        readonly accessToken: string;
        readonly agentSessionId: string;
        readonly externalUrls: ReadonlyArray<{ readonly label: string; readonly url: string }>;
      }) {
        const response = yield* executeGraphql(
          input.accessToken,
          `mutation AgentSessionUpdate($id: String!, $input: AgentSessionUpdateInput!) {
            agentSessionUpdate(id: $id, input: $input) {
              success
            }
          }`,
          {
            id: input.agentSessionId,
            input: {
              externalUrls: input.externalUrls,
            },
          },
        );
        const result = yield* decodeGraphql(LinearAgentSessionUpdateGraphqlResponse)(response);

        if (!result.data.agentSessionUpdate.success) {
          return yield* new LinearHttpClientError({
            cause: "agentSessionUpdate returned success=false",
            reason: "InvalidGraphqlResponse",
          });
        }

        return undefined;
      });

      return LinearHttpClient.of({
        createAgentActivity,
        exchangeOAuthCode,
        fetchViewer,
        getIssueLabels,
        updateAgentSessionExternalUrls,
      });
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer));
}

export class LinearHttpClientError extends Schema.TaggedErrorClass<LinearHttpClientError>()(
  "LinearHttpClientError",
  {
    cause: Schema.Defect,
    reason: Schema.Literals(["HttpError", "InvalidGraphqlRequest", "InvalidGraphqlResponse"]),
  },
) {}
