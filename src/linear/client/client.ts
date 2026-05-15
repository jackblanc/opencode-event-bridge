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

export class LinearHttpClient extends Context.Service<
  LinearHttpClient,
  {
    exchangeOAuthCode(input: {
      readonly clientId: string;
      readonly clientSecret: string;
      readonly code: string;
      readonly redirectUri: string;
    }): Effect.Effect<typeof LinearOAuthTokenResponse.Type, LinearHttpClientError>;
    fetchViewer(
      accessToken: string,
    ): Effect.Effect<typeof LinearViewerGraphqlResponse.Type, LinearHttpClientError>;
  }
>()("app/LinearHttpClient") {
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

      return LinearHttpClient.of({
        exchangeOAuthCode,
        fetchViewer,
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
