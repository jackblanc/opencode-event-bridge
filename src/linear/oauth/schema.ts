import { Schema } from "effect";

export const LinearOAuthTokenResponse = Schema.Struct({
  access_token: Schema.String,
  expires_in: Schema.Finite,
  refresh_token: Schema.String,
});

export const LinearViewerGraphqlResponse = Schema.Struct({
  data: Schema.Struct({
    viewer: Schema.Struct({
      id: Schema.String,
      organization: Schema.Struct({
        id: Schema.String,
        name: Schema.String,
      }),
    }),
  }),
  errors: Schema.optionalKey(Schema.Never),
  extensions: Schema.optionalKey(Schema.Unknown),
});

export const LinearOrgAuthRecord = Schema.Struct({
  accessToken: Schema.String,
  accessTokenExpiresAt: Schema.Finite,
  appUserId: Schema.String,
  organizationId: Schema.String,
  organizationName: Schema.String,
  refreshToken: Schema.String,
});
