import type {
  CredentialProviderConfiguration,
  MetadataConfiguration,
  PrivateEndpoint,
  TargetConfiguration,
} from "@aws-sdk/client-bedrock-agentcore-control";
import z from "zod";
import { InputValidationError } from "../../../../errors";
import { type AppIO, SourceResolver } from "../../../../io";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import {
  assertMutuallyExclusiveFlags,
  coreOptsFromCtx,
  parseJsonArrayFlag,
  parseJsonObjectFlag,
} from "../../../utils";
import type { GatewayTargetUpdatePatch } from "../../types";

const TARGET = "Target:";
const DEFINITION = "Definition:";
const CREDENTIALS = "Credentials & networking:";
const CLEAR = "Clear (unset a field):";

export const createUpdateGatewayTargetHandler = (core: Core, io: AppIO) =>
  createHandler({
    name: "update",
    description: "update a Gateway Target",
    flags: [
      flag("gateway-id", "the parent Gateway ID", z.string().optional(), { group: TARGET }),
      flag("target-id", "the Target ID", z.string().optional(), { group: TARGET }),
      flag("name", "updated Target name", z.string().optional(), { group: TARGET }),
      flag("description", "updated Target description", z.string().optional(), { group: TARGET }),
      flag(
        "endpoint",
        "updated endpoint for an existing MCP server Target",
        z.string().optional(),
        {
          group: DEFINITION,
        },
      ),
      flag(
        "target-configuration",
        "complete replacement Target configuration (JSON; inline, file://<path>, or - for stdin)",
        z.string().optional(),
        { group: DEFINITION },
      ),
      flag(
        "credential-provider-configurations",
        "replacement outbound credentials (JSON array; inline, file://<path>, or - for stdin)",
        z.string().optional(),
        { group: CREDENTIALS },
      ),
      flag(
        "metadata-configuration",
        "replacement metadata propagation (JSON; inline, file://<path>, or - for stdin)",
        z.string().optional(),
        { group: CREDENTIALS },
      ),
      flag(
        "private-endpoint",
        "replacement private endpoint (JSON; inline, file://<path>, or - for stdin)",
        z.string().optional(),
        { group: CREDENTIALS },
      ),
      flag("clear-description", "remove the Target description", z.boolean(), { group: CLEAR }),
      flag("clear-credential-provider-configurations", "remove outbound credentials", z.boolean(), {
        group: CLEAR,
      }),
      flag("clear-metadata-configuration", "remove metadata propagation", z.boolean(), {
        group: CLEAR,
      }),
      flag("clear-private-endpoint", "remove private endpoint configuration", z.boolean(), {
        group: CLEAR,
      }),
    ],
    handle: async (ctx, flags) => {
      if (!flags["gateway-id"]) {
        throw new InputValidationError("required option '--gateway-id <gateway-id>' not specified");
      }
      if (!flags["target-id"]) {
        throw new InputValidationError("required option '--target-id <target-id>' not specified");
      }

      assertMutuallyExclusiveFlags(flags, ["description", "clear-description"]);
      assertMutuallyExclusiveFlags(flags, [
        "credential-provider-configurations",
        "clear-credential-provider-configurations",
      ]);
      assertMutuallyExclusiveFlags(flags, [
        "metadata-configuration",
        "clear-metadata-configuration",
      ]);
      assertMutuallyExclusiveFlags(flags, ["private-endpoint", "clear-private-endpoint"]);
      assertMutuallyExclusiveFlags(flags, ["endpoint", "target-configuration"]);

      const source = new SourceResolver({ stdin: io.stdin });
      const targetConfiguration = parseJsonObjectFlag<TargetConfiguration>(
        "target-configuration",
        await source.resolveText("target-configuration", flags["target-configuration"]),
      );
      const credentialProviderConfigurations = parseJsonArrayFlag<CredentialProviderConfiguration>(
        "credential-provider-configurations",
        await source.resolveText(
          "credential-provider-configurations",
          flags["credential-provider-configurations"],
        ),
      );
      const metadataConfiguration = parseJsonObjectFlag<MetadataConfiguration>(
        "metadata-configuration",
        await source.resolveText("metadata-configuration", flags["metadata-configuration"]),
      );
      const privateEndpoint = parseJsonObjectFlag<PrivateEndpoint>(
        "private-endpoint",
        await source.resolveText("private-endpoint", flags["private-endpoint"]),
      );

      const mutations: Omit<GatewayTargetUpdatePatch, "gatewayId" | "targetId"> = {
        name: flags.name,
        description: flags["clear-description"] ? null : flags.description,
        endpoint: flags.endpoint,
        targetConfiguration,
        credentialProviderConfigurations: flags["clear-credential-provider-configurations"]
          ? null
          : credentialProviderConfigurations,
        metadataConfiguration: flags["clear-metadata-configuration"] ? null : metadataConfiguration,
        privateEndpoint: flags["clear-private-endpoint"] ? null : privateEndpoint,
      };
      if (Object.values(mutations).every((value) => value === undefined)) {
        throw new InputValidationError("Target update requires at least one mutation option");
      }
      const patch: GatewayTargetUpdatePatch = {
        gatewayId: flags["gateway-id"],
        targetId: flags["target-id"],
        ...mutations,
      };

      ctx
        .require(JsonRendererKey)
        .renderJson(await core.gateway.updateGatewayTarget(patch, coreOptsFromCtx(ctx)));
    },
  });
