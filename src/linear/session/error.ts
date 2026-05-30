import { Schema } from "effect";

export class LinearSessionProcessorError extends Schema.TaggedErrorClass<LinearSessionProcessorError>()(
  "LinearSessionProcessorError",
  {
    cause: Schema.optional(Schema.Defect),
    reason: Schema.Literals([
      "AuthFailure",
      "LinearFailure",
      "MissingAgentSession",
      "OpenCodeFailure",
      "StoreFailure",
    ]),
  },
) {}

export const errorBody = (reason: string) => {
  if (reason === "MissingAgentSession") {
    return "No OpenCode session.";
  }

  return "OpenCode run failed. Check bridge logs.";
};
