import { Schema } from "effect";

const ExtraFields = Schema.Record(Schema.String, Schema.Unknown);
const OptionalString = Schema.optionalKey(Schema.NullOr(Schema.String));

const WebhookEnvelopeFields = {
  createdAt: Schema.String,
  organizationId: Schema.String,
  webhookId: Schema.String,
  webhookTimestamp: Schema.Number,
};

const AgentSessionWebhookPayload = Schema.StructWithRest(
  Schema.Struct({
    appUserId: Schema.String,
    archivedAt: OptionalString,
    comment: Schema.StructWithRest(
      Schema.Struct({
        body: Schema.String,
        id: Schema.String,
        issueId: Schema.String,
        userId: Schema.String,
      }),
      [ExtraFields],
    ),
    commentId: Schema.String,
    createdAt: Schema.String,
    creatorId: OptionalString,
    endedAt: OptionalString,
    id: Schema.String,
    issue: Schema.StructWithRest(
      Schema.Struct({
        description: OptionalString,
        id: Schema.String,
        identifier: Schema.String,
        labels: Schema.optionalKey(
          Schema.Array(
            Schema.StructWithRest(
              Schema.Struct({
                name: Schema.String,
              }),
              [ExtraFields],
            ),
          ),
        ),
        team: Schema.StructWithRest(
          Schema.Struct({
            id: Schema.String,
            key: Schema.String,
            name: Schema.String,
          }),
          [ExtraFields],
        ),
        teamId: Schema.String,
        title: Schema.String,
        url: Schema.String,
      }),
      [ExtraFields],
    ),
    issueId: Schema.String,
    organizationId: Schema.String,
    sourceCommentId: OptionalString,
    sourceMetadata: Schema.optionalKey(Schema.NullOr(ExtraFields)),
    startedAt: OptionalString,
    status: Schema.String,
    summary: OptionalString,
    updatedAt: Schema.String,
    url: Schema.String,
  }),
  [ExtraFields],
);

const IssueWebhookPayload = Schema.StructWithRest(
  Schema.Struct({
    ...WebhookEnvelopeFields,
    action: Schema.String,
    type: Schema.Literal("Issue"),
    data: Schema.StructWithRest(
      Schema.Struct({
        id: Schema.String,
        identifier: Schema.String,
        state: Schema.StructWithRest(
          Schema.Struct({
            color: Schema.String,
            id: Schema.String,
            name: Schema.String,
            type: Schema.String,
          }),
          [ExtraFields],
        ),
      }),
      [ExtraFields],
    ),
    updatedFrom: Schema.optionalKey(Schema.NullOr(ExtraFields)),
    url: Schema.String,
  }),
  [ExtraFields],
);

const CreatedAgentSessionEventWebhookPayload = Schema.StructWithRest(
  Schema.Struct({
    ...WebhookEnvelopeFields,
    action: Schema.Literal("created"),
    type: Schema.Literal("AgentSessionEvent"),
    agentSession: AgentSessionWebhookPayload,
    appUserId: Schema.String,
    guidance: Schema.optionalKey(
      Schema.NullOr(
        Schema.Array(
          Schema.StructWithRest(
            Schema.Struct({
              body: Schema.String,
              origin: ExtraFields,
            }),
            [ExtraFields],
          ),
        ),
      ),
    ),
    oauthClientId: Schema.String,
    previousComments: Schema.optionalKey(Schema.NullOr(Schema.Array(ExtraFields))),
    promptContext: Schema.String,
  }),
  [ExtraFields],
);

const PromptedAgentSessionEventWebhookPayload = Schema.StructWithRest(
  Schema.Struct({
    ...WebhookEnvelopeFields,
    action: Schema.Literal("prompted"),
    type: Schema.Literal("AgentSessionEvent"),
    agentActivity: Schema.StructWithRest(
      Schema.Struct({
        agentSessionId: Schema.String,
        content: Schema.StructWithRest(
          Schema.Struct({
            body: Schema.String,
            type: Schema.String,
          }),
          [ExtraFields],
        ),
        createdAt: Schema.String,
        id: Schema.String,
        signal: OptionalString,
        updatedAt: Schema.String,
        userId: Schema.String,
      }),
      [ExtraFields],
    ),
    agentSession: AgentSessionWebhookPayload,
    appUserId: Schema.String,
    guidance: Schema.optionalKey(Schema.NullOr(Schema.Array(ExtraFields))),
    oauthClientId: Schema.String,
    previousComments: Schema.optionalKey(Schema.NullOr(Schema.Array(ExtraFields))),
    promptContext: OptionalString,
  }),
  [ExtraFields],
);

export const LinearWebhookPayload = Schema.Union([
  IssueWebhookPayload,
  CreatedAgentSessionEventWebhookPayload,
  PromptedAgentSessionEventWebhookPayload,
]);

export type LinearWebhookPayload = Schema.Schema.Type<typeof LinearWebhookPayload>;
