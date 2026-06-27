import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

import LinearWebhookReceiver from "./src/workers/linear-ingress.ts";
import LinearWebhookProcessor from "./src/workers/linear-webhook-processor.ts";

export default Alchemy.Stack(
  "OpenCodeEventBridge",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const receiver = yield* LinearWebhookReceiver;
    yield* LinearWebhookProcessor;

    return receiver.url;
  }),
);
