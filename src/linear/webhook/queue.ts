import * as Cloudflare from "alchemy/Cloudflare";

export const LinearWebhookQueue = Cloudflare.Queues.Queue("LinearWebhookQueue");
