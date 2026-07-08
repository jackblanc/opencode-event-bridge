import { Schema } from "effect";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema";

export class LinearWebhookBadRequest extends Schema.TaggedErrorClass<LinearWebhookBadRequest>()(
  "LinearWebhookBadRequest",
  {
    cause: Schema.optional(Schema.Defect()),
    reason: Schema.Literals(["InvalidPayload", "EventMismatch"]),
  },
  { httpApiStatus: 400 },
) {}

export class LinearWebhookUnauthorized extends Schema.TaggedErrorClass<LinearWebhookUnauthorized>()(
  "LinearWebhookUnauthorized",
  {
    cause: Schema.optional(Schema.Defect()),
    reason: Schema.Literals(["StaleTimestamp", "InvalidSignature", "OrganizationNotAllowed"]),
  },
  { httpApiStatus: 401 },
) {}

export class LinearOAuthBadRequest extends Schema.TaggedErrorClass<LinearOAuthBadRequest>()(
  "LinearOAuthBadRequest",
  {
    reason: Schema.Literal("InvalidState"),
  },
  { httpApiStatus: 400 },
) {}

export class LinearOAuthUpstreamError extends Schema.TaggedErrorClass<LinearOAuthUpstreamError>()(
  "LinearOAuthUpstreamError",
  {
    cause: Schema.optional(Schema.Defect()),
    reason: Schema.Literals([
      "InvalidCallbackUrl",
      "LinearRequestFailed",
      "InvalidTokenResponse",
      "InvalidViewerResponse",
    ]),
  },
  { httpApiStatus: 502 },
) {}

export class LinearOAuthForbidden extends Schema.TaggedErrorClass<LinearOAuthForbidden>()(
  "LinearOAuthForbidden",
  {
    reason: Schema.Literal("OrganizationNotAllowed"),
  },
  { httpApiStatus: 403 },
) {}

const LinearWebhookReceiverResult = Schema.Struct({
  queued: Schema.Boolean,
}).pipe(HttpApiSchema.status("OK"));

const receiveLinearWebhook = HttpApiEndpoint.post("receiveLinearWebhook", "/api/webhook/linear", {
  headers: {
    "linear-delivery": Schema.String,
    "linear-event": Schema.String,
    "linear-signature": Schema.String,
  },
  error: [LinearWebhookBadRequest, LinearWebhookUnauthorized],
  success: LinearWebhookReceiverResult,
});

const authorizeLinearOAuth = HttpApiEndpoint.get("authorizeLinearOAuth", "/api/oauth/authorize", {
  error: [LinearOAuthUpstreamError],
});

const completeLinearOAuth = HttpApiEndpoint.get("completeLinearOAuth", "/api/oauth/callback", {
  query: {
    code: Schema.String,
    state: Schema.String,
  },
  error: [LinearOAuthBadRequest, LinearOAuthForbidden, LinearOAuthUpstreamError],
});

class LinearWebhookGroup extends HttpApiGroup.make("LinearWebhook")
  .add(receiveLinearWebhook)
  .add(authorizeLinearOAuth)
  .add(completeLinearOAuth) {}

export class LinearWebhookApi extends HttpApi.make("LinearWebhookApi").add(LinearWebhookGroup) {}
