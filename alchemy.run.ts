import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

import LinearWebhookProcessor from "./src/linear/webhook-processor.ts";
import LinearWebhookReceiver from "./src/linear/webhook-receiver.ts";

export default Alchemy.Stack(
  "OpenCodeEventBridge",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const receiver = yield* LinearWebhookReceiver;
    const tunnel = yield* Cloudflare.Tunnel("OpenCodeTunnel", {
      ingress: [{ service: "http://localhost:4096" }],
    });
    const service = yield* Cloudflare.VpcService("OpenCodeVpcService", {
      httpPort: 4096,
      host: {
        hostname: "localhost",
        resolverNetwork: { tunnelId: tunnel.tunnelId },
      },
    });
    const processor = yield* LinearWebhookProcessor;

    yield* processor.bind("OpenCodeVpcService", {
      bindings: [
        {
          type: "vpc_service",
          name: "OPENCODE",
          serviceId: service.serviceId,
        },
      ],
    });

    return receiver.url;
  }),
);
