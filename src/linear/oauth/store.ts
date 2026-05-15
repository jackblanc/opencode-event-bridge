import * as Cloudflare from "alchemy/Cloudflare";

export const LinearOAuthStateStore = Cloudflare.KVNamespace("LinearOAuthStateStore");

export const LinearOrgAuthStore = Cloudflare.KVNamespace("LinearOrgAuthStore");
