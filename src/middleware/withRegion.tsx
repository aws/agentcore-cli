import { homedir } from "node:os";
import { join } from "node:path";
import { RegionKey } from "../handlers/keys";
import { readTextFile } from "../io";
import { type Middleware } from "../router";

// DEFAULT_REGION is the final fallback when no region is configured anywhere.
const DEFAULT_REGION = "us-east-1";

// regionFromConfigFile reads the `region` setting for the active profile from the
// shared AWS config file (~/.aws/config, or $AWS_CONFIG_FILE). The active profile
// is $AWS_PROFILE, else "default". Returns undefined if the file, profile, or
// setting is absent — never throws.
async function regionFromConfigFile(): Promise<string | undefined> {
  const path = process.env.AWS_CONFIG_FILE || join(homedir(), ".aws", "config");
  let text: string;
  try {
    text = await readTextFile(path);
  } catch {
    return undefined; // no config file
  }

  // In ~/.aws/config the default profile is "[default]" and named profiles are
  // "[profile name]".
  const profile = process.env.AWS_PROFILE || "default";
  const wanted = profile === "default" ? "default" : `profile ${profile}`;

  let inSection = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("[") && line.endsWith("]")) {
      inSection = line.slice(1, -1).trim() === wanted;
      continue;
    }
    if (inSection && line.startsWith("region")) {
      const value = line.split("=")[1]?.trim();
      if (value) return value;
    }
  }
  return undefined;
}

// resolveRegion picks the effective AWS region: an explicit --region (already on
// the context), then AWS_REGION / AWS_DEFAULT_REGION, then the shared config file,
// finally DEFAULT_REGION. It always resolves to a value.
async function resolveRegion(flagRegion: string | undefined): Promise<string> {
  return (
    flagRegion ||
    process.env.AWS_REGION ||
    process.env.AWS_DEFAULT_REGION ||
    (await regionFromConfigFile()) ||
    DEFAULT_REGION
  );
}

// withRegion resolves the effective AWS region and pins it onto the context under
// RegionKey so the whole app uses a single, consistent value. There is always a
// region: it falls back to DEFAULT_REGION when nothing else is configured.
export function withRegion(): Middleware {
  return (h) => ({
    name: () => h.name(),
    description: () => h.description(),
    flags: () => h.flags(),
    arguments: () => h.arguments(),
    doesSupportTui: () => h.doesSupportTui(),
    children: () => h.children(),
    handle: async (ctx, flags, args) => {
      const region = await resolveRegion(ctx.value(RegionKey));
      await h.handle(ctx.withValue(RegionKey, region), flags, args);
    },
  });
}
