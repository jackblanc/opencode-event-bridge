import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as GitHub from "alchemy/GitHub";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

const env = (name: string) =>
  Effect.gen(function* () {
    const value = process.env[name];
    if (value === undefined || value === "") {
      return yield* Effect.die(`Missing environment variable: ${name}`);
    }
    return value;
  });

export default Alchemy.Stack(
  "GitHub",
  {
    // oxlint-disable-next-line typescript/no-unsafe-assignment
    providers: GitHub.providers().pipe(Layer.provideMerge(Cloudflare.providers())),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const owner = process.env["GITHUB_OWNER"] ?? "jackblanc";
    const repository = process.env["GITHUB_REPOSITORY_NAME"] ?? "opencode-event-bridge";
    const accountId = yield* env("CLOUDFLARE_ACCOUNT_ID");

    const token = yield* Cloudflare.AccountApiToken("CIToken", {
      accountId,
      policies: [
        {
          effect: "allow",
          permissionGroups: [
            "Workers Scripts Write",
            "Workers KV Storage Write",
            "Queues Write",
            "Cloudflare Tunnel Write",
            "Connectivity Directory Admin",
            "Secrets Store Write",
          ],
          resources: {
            [`com.cloudflare.api.account.${accountId}`]: "*",
          },
        },
      ],
    });

    const secrets = {
      CLOUDFLARE_API_TOKEN: token.value,
      CLOUDFLARE_ACCOUNT_ID: Redacted.make(accountId),
    };

    yield* Effect.all(
      Object.entries(secrets).map(([name, value]) =>
        GitHub.Secret(name, {
          owner,
          repository,
          name,
          value,
        }),
      ),
    );
  }),
);
