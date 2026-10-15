import z from "zod";
import type { AwsCredentialProvider } from "../core/types";
import type { CliVersionManager } from "../cliVersionManager";
import { contextKey, globalFlag } from "../router";

// These keys are group-level flags declared on the root router. Because a
// GlobalFlag is also a typed ContextKey, handlers read its validated value back
// out of the context via `ctx.value(Key)`.

// RegionKey has no default: an omitted --region must resolve to undefined so the
// withRegion middleware can fall back to AWS_REGION / the shared config file.
export const RegionKey = globalFlag("region", "AWS region", z.string().optional());

// withRegion overwrites RegionKey with the fully-resolved region (flag -> env ->
// config -> DEFAULT_REGION) before any handler runs, so by the time a leaf reads
// ctx.value(RegionKey) it's never undefined. This key preserves whether --region
// was actually passed, for callers (like the v0 compat path) that must tell
// "user asked for a region" apart from "we picked one for them".
export const RegionExplicitKey = contextKey<boolean>("region.explicit");

export const DebugKey = globalFlag("debug", "debug logging", z.boolean().default(false));

export const JsonKey = globalFlag("json", "JSON output", z.boolean().default(false));

export const EndpointKey = globalFlag(
  "endpoint-url",
  "endpoint URL override",
  z.string().optional(),
);

/** Explicit credential provider pinned by project target resolution. */
export const AwsCredentialProviderKey = contextKey<AwsCredentialProvider>("aws.credentialProvider");

export const CliVersionManagerKey = contextKey<CliVersionManager>("cli.versionManager");
