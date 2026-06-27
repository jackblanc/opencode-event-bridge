import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

import { openCodePrivateHost } from "./config.ts";

const OpenCodeTunnel = Cloudflare.Tunnel.Tunnel("OpenCodeTunnel", {
  ingress: [{ service: "http_status:404" }],
});

export const OpenCodeVpcService = Effect.gen(function* () {
  const tunnel = yield* OpenCodeTunnel;

  return yield* Cloudflare.VpcService.VpcService("OpenCodeVpcService", {
    host: {
      ipv4: openCodePrivateHost,
      network: { tunnelId: tunnel.tunnelId },
    },
    httpPort: 4096,
  });
});
