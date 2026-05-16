import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

const OpenCodeTunnel = Cloudflare.Tunnel("OpenCodeTunnel", {
  ingress: [{ service: "http://localhost:4096" }],
});

export const OpenCodeVpcService = Effect.gen(function* () {
  const tunnel = yield* OpenCodeTunnel;

  return yield* Cloudflare.VpcService("OpenCodeVpcService", {
    host: {
      hostname: "localhost",
      resolverNetwork: { tunnelId: tunnel.tunnelId },
    },
    httpPort: 4096,
  });
});
