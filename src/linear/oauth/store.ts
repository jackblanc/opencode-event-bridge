import * as Cloudflare from "alchemy/Cloudflare";

export const LinearOAuthStateStore = Cloudflare.KV.Namespace("LinearOAuthStateStore");

export const LinearOrgAuthStore = Cloudflare.KV.Namespace("LinearOrgAuthStore");
