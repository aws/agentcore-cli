import { describe, expect, it } from "bun:test";
import { PaymentManagerSchema } from "./payment";
describe("payment manager custom validation", () => {
  it("requires JWT authorizer configuration only for CUSTOM_JWT", () => {
    expect(
      PaymentManagerSchema.safeParse({
        name: "payments",
        authorizerType: "CUSTOM_JWT",
      }).success,
    ).toBe(false);
    expect(
      PaymentManagerSchema.safeParse({
        name: "payments",
        authorizerType: "CUSTOM_JWT",
        authorizerConfiguration: {
          customJWTAuthorizer: {
            discoveryUrl: "https://example.com/.well-known/openid-configuration",
          },
        },
      }).success,
    ).toBe(true);
  });
});
