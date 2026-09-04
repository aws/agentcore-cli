import { describe, expect, test } from "bun:test";
import { EnvFeatureFlags } from "./env";
import { FEATURE_FLAGS } from "./types";

const VARIABLE = FEATURE_FLAGS.imperativeDeploy;

describe("EnvFeatureFlags", () => {
  test("a flag whose variable is unset is disabled", () => {
    const flags = new EnvFeatureFlags({});
    expect(flags.isEnabled("imperativeDeploy")).toBe(false);
    expect(flags.enabled()).toEqual([]);
  });

  test("exactly '1' enables a flag", () => {
    const flags = new EnvFeatureFlags({ [VARIABLE]: "1" });
    expect(flags.isEnabled("imperativeDeploy")).toBe(true);
    expect(flags.enabled()).toEqual(["imperativeDeploy"]);
  });

  test("surrounding whitespace around '1' is ignored", () => {
    expect(new EnvFeatureFlags({ [VARIABLE]: " 1 " }).isEnabled("imperativeDeploy")).toBe(true);
    expect(new EnvFeatureFlags({ [VARIABLE]: "\t1\n" }).isEnabled("imperativeDeploy")).toBe(true);
  });

  // The contract is "=1 enables", not truthiness: a value that reads as "on" in
  // other tools must still leave the experiment off here.
  test.each(["0", "true", "yes", "on", "", "11", "1.0"])("%j does not enable a flag", (value) => {
    const flags = new EnvFeatureFlags({ [VARIABLE]: value });
    expect(flags.isEnabled("imperativeDeploy")).toBe(false);
    expect(flags.enabled()).toEqual([]);
  });

  test("an undefined value (present key, no value) is disabled", () => {
    expect(new EnvFeatureFlags({ [VARIABLE]: undefined }).isEnabled("imperativeDeploy")).toBe(
      false,
    );
  });

  test("environment variables that are not flags are ignored", () => {
    const flags = new EnvFeatureFlags({
      AGENTCORE_CLI_EXPERIMENTAL_SOMETHING_ELSE: "1",
      IMPERATIVE_DEPLOY: "1",
      imperativeDeploy: "1",
    });
    expect(flags.enabled()).toEqual([]);
  });

  test("reads the environment once, at construction", () => {
    const env: Record<string, string | undefined> = { [VARIABLE]: "1" };
    const flags = new EnvFeatureFlags(env);
    env[VARIABLE] = "0";
    expect(flags.isEnabled("imperativeDeploy")).toBe(true);
  });
});
