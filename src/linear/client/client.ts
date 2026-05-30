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
const repoLabelPrefix = "repo:";

const normalize = (value: string) => value.trim().toLowerCase();

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
    body: Schema.String,
    type: Schema.Literal("elicitation"),
  }),
  Schema.Struct({
    action: Schema.String,
    parameter: Schema.String,
    result: Schema.optional(Schema.String),
    type: Schema.Literal("action"),
  }),
]);

export type LinearAgentActivityContent = Schema.Schema.Type<typeof LinearAgentActivityContent>;

export type LinearAgentActivitySignalMetadata = {
  readonly options: ReadonlyArray<{
    readonly label: string;
    readonly value: string;
  }>;
};

export type LinearAgentActivityInput = {
  readonly accessToken: string;
  readonly agentSessionId: string;
  readonly content: LinearAgentActivityContent;
  readonly signal?: "select";
  readonly signalMetadata?: LinearAgentActivitySignalMetadata;
};

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

const LinearGraphqlErrorExtensions = Schema.StructWithRest(
  Schema.Struct({
    type: Schema.optionalKey(Schema.String),
    userError: Schema.optionalKey(Schema.Boolean),
    userPresentableMessage: Schema.optionalKey(Schema.String),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);

const LinearGraphqlError = Schema.Struct({
  extensions: Schema.optionalKey(LinearGraphqlErrorExtensions),
  message: Schema.String,
});

const LinearGraphqlErrorResponse = Schema.Struct({
  data: Schema.optionalKey(Schema.Unknown),
  errors: Schema.Array(LinearGraphqlError),
  extensions: Schema.optionalKey(Schema.Unknown),
});

type LinearGraphqlError = Schema.Schema.Type<typeof LinearGraphqlError>;

const graphqlErrorMessage = (errors: ReadonlyArray<LinearGraphqlError>) =>
  errors.map((error) => error.extensions?.userPresentableMessage ?? error.message).join("\n");

const graphqlErrorIsPermissionFailure = (error: LinearGraphqlError) =>
  error.extensions?.type === "authentication error" || error.extensions?.type === "forbidden";

const graphqlFailureReason = (
  errors: ReadonlyArray<LinearGraphqlError>,
): "InvalidGraphqlResponse" | "PermissionFailure" => {
  if (errors.some(graphqlErrorIsPermissionFailure)) {
    return "PermissionFailure";
  }

  return "InvalidGraphqlResponse";
};

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
      team: Schema.Struct({ id: Schema.String }),
      labels: Schema.Struct({
        nodes: Schema.Array(
          Schema.Struct({
            id: Schema.String,
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

const LinearIssueAgentSessionsGraphqlResponse = Schema.Struct({
  data: Schema.Struct({
    agentSessions: Schema.Struct({
      nodes: Schema.Array(
        Schema.Struct({
          id: Schema.String,
          issue: Schema.NullOr(Schema.Struct({ id: Schema.String })),
        }),
      ),
      pageInfo: Schema.Struct({
        endCursor: Schema.NullOr(Schema.String),
        hasNextPage: Schema.Boolean,
      }),
    }),
  }),
  errors: Schema.optionalKey(Schema.Never),
  extensions: Schema.optionalKey(Schema.Unknown),
});

const LinearIssueLabelsSearchGraphqlResponse = Schema.Struct({
  data: Schema.Struct({
    issueLabels: Schema.Struct({
      nodes: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
    }),
  }),
  errors: Schema.optionalKey(Schema.Never),
  extensions: Schema.optionalKey(Schema.Unknown),
});

const LinearIssueUpdateGraphqlResponse = Schema.Struct({
  data: Schema.Struct({
    issueUpdate: Schema.Struct({
      success: Schema.Boolean,
    }),
  }),
  errors: Schema.optionalKey(Schema.Never),
  extensions: Schema.optionalKey(Schema.Unknown),
});

const LinearIssueLabelCreateGraphqlResponse = Schema.Struct({
  data: Schema.Struct({
    issueLabelCreate: Schema.Struct({
      success: Schema.Boolean,
      issueLabel: Schema.Struct({
        id: Schema.String,
        name: Schema.String,
      }),
    }),
  }),
  errors: Schema.optionalKey(Schema.Never),
  extensions: Schema.optionalKey(Schema.Unknown),
});

export type LinearHttpClientService = {
  createAgentActivity(
    input: LinearAgentActivityInput,
  ): Effect.Effect<{ readonly id: string }, LinearHttpClientError>;
  exchangeOAuthCode(input: {
    readonly clientId: string;
    readonly clientSecret: string;
    readonly code: string;
    readonly redirectUri: string;
  }): Effect.Effect<typeof LinearOAuthTokenResponse.Type, LinearHttpClientError>;
  refreshOAuthToken(input: {
    readonly clientId: string;
    readonly clientSecret: string;
    readonly refreshToken: string;
  }): Effect.Effect<typeof LinearOAuthTokenResponse.Type, LinearHttpClientError>;
  fetchViewer(
    accessToken: string,
  ): Effect.Effect<typeof LinearViewerGraphqlResponse.Type, LinearHttpClientError>;
  getIssueLabels(input: { readonly accessToken: string; readonly issueId: string }): Effect.Effect<
    ReadonlyArray<{
      readonly id: string;
      readonly name: string;
      readonly parent: { readonly name: string } | null;
    }>,
    LinearHttpClientError
  >;
  getIssueAgentSessionIds(input: {
    readonly accessToken: string;
    readonly issueId: string;
  }): Effect.Effect<ReadonlyArray<string>, LinearHttpClientError>;
  addIssueLabel(input: {
    readonly accessToken: string;
    readonly issueId: string;
    readonly labelName: string;
  }): Effect.Effect<void, LinearHttpClientError>;
  updateAgentSessionPlan(input: {
    readonly accessToken: string;
    readonly agentSessionId: string;
    readonly plan: ReadonlyArray<{
      readonly content: string;
      readonly status: "pending" | "inProgress" | "completed" | "canceled";
    }>;
  }): Effect.Effect<void, LinearHttpClientError>;
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
      const rawClient = (yield* HttpClient.HttpClient).pipe(
        HttpClient.mapRequest(HttpClientRequest.prependUrl(linearApiUrl)),
        HttpClient.mapRequest(HttpClientRequest.acceptJson),
      );
      const client = rawClient.pipe(HttpClient.filterStatusOk);

      const executeGraphql = (accessToken: string, query: string, variables: unknown) =>
        Effect.gen(function* () {
          const request = yield* HttpClientRequest.post(linearGraphqlPath).pipe(
            HttpClientRequest.setHeader("authorization", `Bearer ${accessToken}`),
            HttpClientRequest.bodyJson({ query, variables }),
            Effect.mapError(
              (cause) => new LinearHttpClientError({ cause, reason: "InvalidGraphqlRequest" }),
            ),
          );

          return yield* rawClient
            .execute(request)
            .pipe(
              Effect.mapError((cause) => new LinearHttpClientError({ cause, reason: "HttpError" })),
            );
        });

      const decodeGraphql =
        <S extends Schema.Top>(schema: S) =>
        (response: HttpClientResponse.HttpClientResponse) =>
          HttpClientResponse.schemaBodyJson(Schema.Unknown)(response).pipe(
            Effect.mapError(
              (cause) => new LinearHttpClientError({ cause, reason: "InvalidGraphqlResponse" }),
            ),
            Effect.flatMap((body) =>
              Schema.decodeUnknownEffect(LinearGraphqlErrorResponse)(body).pipe(
                Effect.matchEffect({
                  onFailure: () =>
                    Schema.decodeUnknownEffect(schema)(body).pipe(
                      Effect.mapError(
                        (cause) =>
                          new LinearHttpClientError({
                            cause,
                            reason: "InvalidGraphqlResponse",
                          }),
                      ),
                    ),
                  onSuccess: (failure) =>
                    new LinearHttpClientError({
                      cause: graphqlErrorMessage(failure.errors),
                      reason: graphqlFailureReason(failure.errors),
                    }),
                }),
              ),
            ),
          );

      const createAgentActivity = Effect.fn("LinearHttpClient.createAgentActivity")(function* (
        input: LinearAgentActivityInput,
      ) {
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
              signal: input.signal,
              signalMetadata: input.signalMetadata,
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

        return { id: result.data.agentActivityCreate.agentActivity.id };
      });

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

      const refreshOAuthToken = Effect.fn("LinearHttpClient.refreshOAuthToken")(function* (input: {
        readonly clientId: string;
        readonly clientSecret: string;
        readonly refreshToken: string;
      }) {
        return yield* HttpClientRequest.post(linearOAuthTokenPath).pipe(
          HttpClientRequest.bodyUrlParams({
            client_id: input.clientId,
            client_secret: input.clientSecret,
            grant_type: "refresh_token",
            refresh_token: input.refreshToken,
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
              team { id }
              labels(first: 250) {
                nodes {
                  id
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

      const getIssueAgentSessionIds = Effect.fn("LinearHttpClient.getIssueAgentSessionIds")(
        function* (input: { readonly accessToken: string; readonly issueId: string }) {
          const ids: Array<string> = [];
          let cursor: string | null = null;
          let hasNextPage = true;

          while (hasNextPage) {
            const response: HttpClientResponse.HttpClientResponse = yield* executeGraphql(
              input.accessToken,
              `query IssueAgentSessions($after: String) {
                agentSessions(first: 100, after: $after, includeArchived: true) {
                  nodes {
                    id
                    issue { id }
                  }
                  pageInfo {
                    endCursor
                    hasNextPage
                  }
                }
              }`,
              { after: cursor },
            );
            const result: Schema.Schema.Type<typeof LinearIssueAgentSessionsGraphqlResponse> =
              yield* decodeGraphql(LinearIssueAgentSessionsGraphqlResponse)(response);

            for (const session of result.data.agentSessions.nodes) {
              if (session.issue?.id === input.issueId) {
                ids.push(session.id);
              }
            }

            cursor = result.data.agentSessions.pageInfo.endCursor;
            hasNextPage = result.data.agentSessions.pageInfo.hasNextPage && cursor !== null;
          }

          return ids;
        },
      );

      const addIssueLabel = Effect.fn("LinearHttpClient.addIssueLabel")(function* (input: {
        readonly accessToken: string;
        readonly issueId: string;
        readonly labelName: string;
      }) {
        const issueResponse = yield* executeGraphql(
          input.accessToken,
          `query IssueLabelsForMutation($id: String!) {
            issue(id: $id) {
              team { id }
              labels(first: 250) { nodes { id name parent { name } } }
            }
          }`,
          { id: input.issueId },
        );
        const issue = yield* decodeGraphql(LinearIssueLabelsGraphqlResponse)(issueResponse);
        const staleRepoLabelIds = issue.data.issue.labels.nodes
          .filter(
            (label) =>
              label.name.startsWith(repoLabelPrefix) &&
              normalize(label.name) !== normalize(input.labelName),
          )
          .map((label) => label.id);

        const labelResponse = yield* executeGraphql(
          input.accessToken,
          `query RepoIssueLabel($filter: IssueLabelFilter) {
            issueLabels(filter: $filter, first: 1) {
              nodes { id name }
            }
          }`,
          {
            filter: {
              name: { eq: input.labelName },
              team: { id: { eq: issue.data.issue.team.id } },
            },
          },
        );
        const labels = yield* decodeGraphql(LinearIssueLabelsSearchGraphqlResponse)(labelResponse);
        const found = labels.data.issueLabels.nodes.find(
          (item) => normalize(item.name) === normalize(input.labelName),
        );

        let label = found;

        if (label === undefined) {
          const createResponse = yield* executeGraphql(
            input.accessToken,
            `mutation IssueLabelCreate($input: IssueLabelCreateInput!) {
              issueLabelCreate(input: $input) {
                success
                issueLabel { id name }
              }
            }`,
            { input: { name: input.labelName, teamId: issue.data.issue.team.id } },
          );
          const created = yield* decodeGraphql(LinearIssueLabelCreateGraphqlResponse)(
            createResponse,
          );

          if (!created.data.issueLabelCreate.success) {
            return yield* new LinearHttpClientError({
              cause: "issueLabelCreate returned success=false",
              reason: "InvalidGraphqlResponse",
            });
          }

          label = created.data.issueLabelCreate.issueLabel;
        }

        const response = yield* executeGraphql(
          input.accessToken,
          `mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
            issueUpdate(id: $id, input: $input) {
              success
            }
          }`,
          {
            id: input.issueId,
            input: { addedLabelIds: [label.id], removedLabelIds: staleRepoLabelIds },
          },
        );
        const result = yield* decodeGraphql(LinearIssueUpdateGraphqlResponse)(response);

        if (!result.data.issueUpdate.success) {
          return yield* new LinearHttpClientError({
            cause: "issueUpdate returned success=false",
            reason: "InvalidGraphqlResponse",
          });
        }

        return undefined;
      });

      const updateAgentSessionPlan = Effect.fn("LinearHttpClient.updateAgentSessionPlan")(
        function* (input: {
          readonly accessToken: string;
          readonly agentSessionId: string;
          readonly plan: ReadonlyArray<{
            readonly content: string;
            readonly status: "pending" | "inProgress" | "completed" | "canceled";
          }>;
        }) {
          const response = yield* executeGraphql(
            input.accessToken,
            `mutation AgentSessionUpdate($id: String!, $input: AgentSessionUpdateInput!) {
              agentSessionUpdate(id: $id, input: $input) {
                success
              }
            }`,
            { id: input.agentSessionId, input: { plan: input.plan } },
          );
          const result = yield* decodeGraphql(LinearAgentSessionUpdateGraphqlResponse)(response);

          if (!result.data.agentSessionUpdate.success) {
            return yield* new LinearHttpClientError({
              cause: "agentSessionUpdate returned success=false",
              reason: "InvalidGraphqlResponse",
            });
          }

          return undefined;
        },
      );

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
        addIssueLabel,
        exchangeOAuthCode,
        fetchViewer,
        getIssueAgentSessionIds,
        getIssueLabels,
        refreshOAuthToken,
        updateAgentSessionPlan,
        updateAgentSessionExternalUrls,
      });
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer));
}

export class LinearHttpClientError extends Schema.TaggedErrorClass<LinearHttpClientError>()(
  "LinearHttpClientError",
  {
    cause: Schema.Defect,
    reason: Schema.Literals([
      "HttpError",
      "InvalidGraphqlRequest",
      "InvalidGraphqlResponse",
      "PermissionFailure",
    ]),
  },
) {}
