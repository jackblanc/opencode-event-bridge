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
    providers: GitHub.providers().pipe(Layer.provideMerge(Cloudflare.providers())),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const owner = yield* env("GITHUB_OWNER");
    const repository = process.env["GITHUB_REPOSITORY_NAME"] ?? "opencode-event-bridge";
    const accountId = yield* env("CLOUDFLARE_ACCOUNT_ID");

    const token = yield* Cloudflare.ApiToken.AccountApiToken("CIToken", {
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

    const repositorySecrets = {
      CLOUDFLARE_API_TOKEN: token.value,
      CLOUDFLARE_ACCOUNT_ID: Redacted.make(accountId),
      LINEAR_OAUTH_CLIENT_ID: Redacted.make(yield* env("LINEAR_OAUTH_CLIENT_ID")),
      LINEAR_OAUTH_CLIENT_SECRET: Redacted.make(yield* env("LINEAR_OAUTH_CLIENT_SECRET")),
      LINEAR_WEBHOOK_SECRET: Redacted.make(yield* env("LINEAR_WEBHOOK_SECRET")),
      LINEAR_ALLOWED_ORGANIZATION_ID: Redacted.make(yield* env("LINEAR_ALLOWED_ORGANIZATION_ID")),
    };

    yield* Effect.all(
      Object.entries(repositorySecrets).map(([name, value]) =>
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
