import { Schema } from "effect";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema";

export class LinearWebhookBadRequest extends Schema.TaggedErrorClass<LinearWebhookBadRequest>()(
  "LinearWebhookBadRequest",
  {
    reason: Schema.Literals(["InvalidPayload", "EventMismatch"]),
  },
  { httpApiStatus: 400 },
) {}

export class LinearWebhookUnauthorized extends Schema.TaggedErrorClass<LinearWebhookUnauthorized>()(
  "LinearWebhookUnauthorized",
  {
    reason: Schema.Literals(["StaleTimestamp", "InvalidSignature"]),
  },
  { httpApiStatus: 401 },
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

class LinearWebhookGroup extends HttpApiGroup.make("LinearWebhook").add(receiveLinearWebhook) {}

export class LinearWebhookApi extends HttpApi.make("LinearWebhookApi").add(LinearWebhookGroup) {}
