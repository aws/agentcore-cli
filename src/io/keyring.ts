import { createRequire } from "node:module";
import type { KeychainEntry } from "./localSecrets";

const require = createRequire(import.meta.url);

export function loadKeyring(): { Entry: new (service: string, account: string) => KeychainEntry } {
  return require("@napi-rs/keyring");
}
