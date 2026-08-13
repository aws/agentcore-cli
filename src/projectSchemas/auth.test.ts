import { describe, expect, it } from "bun:test";
import {
  ClaimMatchValueSchema,
  CustomClaimValidationSchema,
  CustomJwtAuthorizerConfigSchema,
  PrivateEndpointSchema,
} from "./auth";
const lattice = {
  selfManagedLatticeResource: {
    resourceConfigurationIdentifier: "rcfg-0123456789abcdef0",
  },
};
const vpc = {
  managedVpcResource: {
    vpcIdentifier: "vpc-0123456789abcdef0",
    subnetIds: ["subnet-0123456789abcdef0"],
    endpointIpAddressType: "IPV4" as const,
  },
};
describe("auth custom validation", () => {
  it("requires exactly one claim match value representation", () => {
    expect(ClaimMatchValueSchema.safeParse({ matchValueString: "admin" }).success).toBe(true);
    expect(
      ClaimMatchValueSchema.safeParse({
        matchValueString: "admin",
        matchValueStringList: ["admin"],
      }).success,
    ).toBe(false);
    expect(ClaimMatchValueSchema.safeParse({}).success).toBe(false);
  });
  it("rejects reserved custom claim names", () => {
    expect(
      CustomClaimValidationSchema.safeParse({
        inboundTokenClaimName: "client_id",
        inboundTokenClaimValueType: "STRING",
        authorizingClaimMatchValue: {
          claimMatchOperator: "EQUALS",
          claimMatchValue: { matchValueString: "user" },
        },
      }).success,
    ).toBe(false);
  });
  it("requires exactly one private endpoint arm", () => {
    expect(PrivateEndpointSchema.safeParse(lattice).success).toBe(true);
    expect(PrivateEndpointSchema.safeParse(vpc).success).toBe(true);
    expect(PrivateEndpointSchema.safeParse({ ...lattice, ...vpc }).success).toBe(false);
    expect(PrivateEndpointSchema.safeParse({}).success).toBe(false);
  });
  it("requires override arms to match the base endpoint and domains to be unique", () => {
    const base = {
      discoveryUrl: "https://example.com/.well-known/openid-configuration",
      allowedAudience: ["audience"],
      privateEndpoint: lattice,
    };
    expect(
      CustomJwtAuthorizerConfigSchema.safeParse({
        ...base,
        privateEndpointOverrides: [{ domain: "example.com", privateEndpoint: vpc }],
      }).success,
    ).toBe(false);
    expect(
      CustomJwtAuthorizerConfigSchema.safeParse({
        ...base,
        privateEndpointOverrides: [
          { domain: "example.com", privateEndpoint: lattice },
          { domain: "example.com", privateEndpoint: lattice },
        ],
      }).success,
    ).toBe(false);
  });
  it("does not allow endpoint overrides without a base endpoint", () => {
    const result = CustomJwtAuthorizerConfigSchema.safeParse({
      discoveryUrl: "https://example.com/.well-known/openid-configuration",
      allowedAudience: ["audience"],
      privateEndpointOverrides: [{ domain: "example.com", privateEndpoint: lattice }],
    });
    expect(result.success).toBe(false);
  });
});
