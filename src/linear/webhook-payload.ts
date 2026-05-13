import { Schema } from "effect";

export const LinearWebhookPayload = Schema.StructWithRest(
  Schema.Struct({
    type: Schema.String,
    action: Schema.String,
    webhookId: Schema.String,
    organizationId: Schema.String,
    webhookTimestamp: Schema.Number,
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);

export type LinearWebhookPayload = typeof LinearWebhookPayload.Type;
