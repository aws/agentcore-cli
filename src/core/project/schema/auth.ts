import { SECURITY_GROUP_ID_PATTERN, SUBNET_ID_PATTERN, VPC_ID_PATTERN } from "./constants";
import { TagsSchema } from "./tags";
import { z } from "zod";
export const GatewayAuthorizerTypeSchema = z.enum(["NONE", "AWS_IAM", "CUSTOM_JWT"]);
export type GatewayAuthorizerType = z.infer<typeof GatewayAuthorizerTypeSchema>;
export const RuntimeAuthorizerTypeSchema = z.enum(["AWS_IAM", "CUSTOM_JWT"]);
export type RuntimeAuthorizerType = z.infer<typeof RuntimeAuthorizerTypeSchema>;
const OIDC_WELL_KNOWN_SUFFIX = "/.well-known/openid-configuration";
const OidcDiscoveryUrlSchema = z
  .string()
  .url("Must be a valid URL")
  .refine((url) => url.startsWith("https://"), {
    message: "OIDC discovery URL must use HTTPS",
  })
  .refine((url) => url.endsWith(OIDC_WELL_KNOWN_SUFFIX), {
    message: `OIDC discovery URL must end with '${OIDC_WELL_KNOWN_SUFFIX}'`,
  });
const MATCH_VALUE_PATTERN = /^[A-Za-z0-9_.-]+$/;
const ALLOWED_SCOPE_PATTERN = /^[\x21\x23-\x5B\x5D-\x7E]+$/;
const CLAIM_NAME_PATTERN = /^[A-Za-z0-9_.:-]+$/;
const RESERVED_CLAIM_NAMES = ["client_id"];
export const ClaimMatchOperatorSchema = z.enum(["EQUALS", "CONTAINS", "CONTAINS_ANY"]);
export type ClaimMatchOperator = z.infer<typeof ClaimMatchOperatorSchema>;
export const ClaimMatchValueSchema = z
  .object({
    matchValueString: z
      .string()
      .min(1)
      .max(255)
      .regex(MATCH_VALUE_PATTERN, "Match value must match [A-Za-z0-9_.-]+")
      .optional(),
    matchValueStringList: z
      .array(
        z
          .string()
          .min(1)
          .max(255)
          .regex(MATCH_VALUE_PATTERN, "Each match value must match [A-Za-z0-9_.-]+"),
      )
      .min(1)
      .max(255)
      .optional(),
  })
  .refine(
    (data) => data.matchValueString !== undefined || data.matchValueStringList !== undefined,
    {
      message: "Either matchValueString or matchValueStringList must be provided",
    },
  )
  .refine(
    (data) => !(data.matchValueString !== undefined && data.matchValueStringList !== undefined),
    {
      message: "Only one of matchValueString or matchValueStringList may be provided",
    },
  );
export type ClaimMatchValue = z.infer<typeof ClaimMatchValueSchema>;
export const InboundTokenClaimValueTypeSchema = z.enum(["STRING", "STRING_ARRAY"]);
export type InboundTokenClaimValueType = z.infer<typeof InboundTokenClaimValueTypeSchema>;
export const CustomClaimValidationSchema = z
  .object({
    inboundTokenClaimName: z
      .string()
      .min(1)
      .max(255)
      .regex(CLAIM_NAME_PATTERN, "Claim name must match [A-Za-z0-9_.-:]+")
      .refine((name) => !RESERVED_CLAIM_NAMES.includes(name), {
        message: `Claim name cannot be a reserved name (${RESERVED_CLAIM_NAMES.join(", ")})`,
      }),
    inboundTokenClaimValueType: InboundTokenClaimValueTypeSchema,
    authorizingClaimMatchValue: z.object({
      claimMatchOperator: ClaimMatchOperatorSchema,
      claimMatchValue: ClaimMatchValueSchema,
    }),
  })
  .strict();
export type CustomClaimValidation = z.infer<typeof CustomClaimValidationSchema>;
export const LATTICE_RESOURCE_CONFIG_PATTERN =
  /^((rcfg-[0-9a-z]{17})|(arn:[a-z0-9-]+:vpc-lattice:[a-zA-Z0-9-]+:\d{12}:resourceconfiguration\/rcfg-[0-9a-z]{17}))$/;
export const EndpointIpAddressTypeSchema = z.enum(["IPV4", "IPV6"]);
export type EndpointIpAddressType = z.infer<typeof EndpointIpAddressTypeSchema>;
export const SelfManagedLatticeResourceSchema = z
  .object({
    resourceConfigurationIdentifier: z
      .string()
      .min(20)
      .max(2048)
      .regex(
        LATTICE_RESOURCE_CONFIG_PATTERN,
        "Must be a VPC Lattice resource-config id (rcfg-...) or its ARN",
      ),
  })
  .strict();
export type SelfManagedLatticeResource = z.infer<typeof SelfManagedLatticeResourceSchema>;
export const ManagedVpcResourceSchema = z
  .object({
    vpcIdentifier: z.string().regex(VPC_ID_PATTERN, "Must be a VPC id (vpc-...)"),
    subnetIds: z
      .array(z.string().regex(SUBNET_ID_PATTERN, "Must be a subnet id (subnet-...)"))
      .min(1),
    endpointIpAddressType: EndpointIpAddressTypeSchema,
    securityGroupIds: z
      .array(z.string().regex(SECURITY_GROUP_ID_PATTERN, "Must be a security group id (sg-...)"))
      .max(5)
      .optional(),
    tags: TagsSchema.optional(),
    routingDomain: z.string().min(3).max(255).optional(),
  })
  .strict();
export type ManagedVpcResource = z.infer<typeof ManagedVpcResourceSchema>;
export const PrivateEndpointSchema = z
  .object({
    selfManagedLatticeResource: SelfManagedLatticeResourceSchema.optional(),
    managedVpcResource: ManagedVpcResourceSchema.optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    const count = [data.selfManagedLatticeResource, data.managedVpcResource].filter(
      (v) => v !== undefined,
    ).length;
    if (count !== 1) {
      ctx.addIssue({
        code: "custom",
        message:
          "A private endpoint must set exactly one of selfManagedLatticeResource or managedVpcResource",
      });
    }
  });
export type PrivateEndpoint = z.infer<typeof PrivateEndpointSchema>;
export const PrivateEndpointOverrideSchema = z
  .object({
    domain: z.string().min(1).max(253),
    privateEndpoint: PrivateEndpointSchema,
  })
  .strict();
export type PrivateEndpointOverride = z.infer<typeof PrivateEndpointOverrideSchema>;
type PrivateEndpointArm = "selfManagedLatticeResource" | "managedVpcResource" | undefined;
function privateEndpointArm(pe: PrivateEndpoint): PrivateEndpointArm {
  if (pe.selfManagedLatticeResource) return "selfManagedLatticeResource";
  if (pe.managedVpcResource) return "managedVpcResource";
  return undefined;
}
export const CustomJwtAuthorizerConfigSchema = z
  .object({
    discoveryUrl: OidcDiscoveryUrlSchema,
    allowedAudience: z.array(z.string().min(1)).optional(),
    allowedClients: z.array(z.string().min(1)).optional(),
    allowedScopes: z
      .array(
        z
          .string()
          .min(1)
          .max(255)
          .regex(ALLOWED_SCOPE_PATTERN, "Scope must be printable ASCII with no spaces or quotes"),
      )
      .optional(),
    customClaims: z.array(CustomClaimValidationSchema).min(1).optional(),
    privateEndpoint: PrivateEndpointSchema.optional(),
    privateEndpointOverrides: z.array(PrivateEndpointOverrideSchema).max(5).optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    const hasAudience = data.allowedAudience && data.allowedAudience.length > 0;
    const hasClients = data.allowedClients && data.allowedClients.length > 0;
    const hasScopes = data.allowedScopes && data.allowedScopes.length > 0;
    const hasClaims = data.customClaims && data.customClaims.length > 0;
    if (!hasAudience && !hasClients && !hasScopes && !hasClaims) {
      ctx.addIssue({
        code: "custom",
        message:
          "At least one of allowedAudience, allowedClients, allowedScopes, or customClaims must be provided",
      });
    }
    const overrides = data.privateEndpointOverrides ?? [];
    if (overrides.length > 0) {
      if (!data.privateEndpoint) {
        ctx.addIssue({
          code: "custom",
          message: "privateEndpointOverrides can only be used when privateEndpoint is also set",
          path: ["privateEndpointOverrides"],
        });
      } else {
        const baseArm = privateEndpointArm(data.privateEndpoint);
        overrides.forEach((o, i) => {
          if (privateEndpointArm(o.privateEndpoint) !== baseArm) {
            ctx.addIssue({
              code: "custom",
              message:
                "privateEndpoint and privateEndpointOverrides must all be the same kind — either all selfManagedLatticeResource or all managedVpcResource",
              path: ["privateEndpointOverrides", i, "privateEndpoint"],
            });
          }
        });
      }
      const seen = new Set<string>();
      overrides.forEach((o, i) => {
        if (seen.has(o.domain)) {
          ctx.addIssue({
            code: "custom",
            message: `Duplicate privateEndpointOverride domain: ${o.domain}`,
            path: ["privateEndpointOverrides", i, "domain"],
          });
        }
        seen.add(o.domain);
      });
    }
  });
export type CustomJwtAuthorizerConfig = z.infer<typeof CustomJwtAuthorizerConfigSchema>;
export const AuthorizerConfigSchema = z.object({
  customJwtAuthorizer: CustomJwtAuthorizerConfigSchema.optional(),
});
export type AuthorizerConfig = z.infer<typeof AuthorizerConfigSchema>;
export const GatewayAuthorizerConfigSchema = AuthorizerConfigSchema;
export type GatewayAuthorizerConfig = AuthorizerConfig;
