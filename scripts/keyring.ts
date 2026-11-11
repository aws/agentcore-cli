import { dirname, join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");

const TARGETS: Record<string, string> = {
  "bun-darwin-x64": "darwin-x64",
  "bun-darwin-arm64": "darwin-arm64",
  "bun-linux-x64": "linux-x64-gnu",
  "bun-linux-arm64": "linux-arm64-gnu",
  "bun-windows-x64": "win32-x64-msvc",
  "bun-windows-arm64": "win32-arm64-msvc",
};

export function keyringBindingPath(target: string): string {
  const platform = TARGETS[target];
  if (!platform) throw new Error("Unsupported keyring target: " + target);
  try {
    const manifest = Bun.resolveSync("@napi-rs/keyring-" + platform + "/package.json", REPO_ROOT);
    return join(dirname(manifest), "keyring." + platform + ".node");
  } catch (cause) {
    throw new Error("Missing keyring binding for " + target + ". Run bun install --os=* --cpu=*.", {
      cause,
    });
  }
}

export function nativeKeyringPlugin(target: string): Bun.BunPlugin {
  const path = keyringBindingPath(target);
  return {
    name: "embedded-keyring",
    setup(build) {
      build.onLoad({ filter: /[/\\]io[/\\]keyring\.ts$/ }, () => ({
        contents: "export function loadKeyring() { return require(" + JSON.stringify(path) + "); }",
        loader: "js",
      }));
    },
  };
}
