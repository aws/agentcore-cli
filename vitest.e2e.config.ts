import { defineConfig } from "vitest/config";
import { TAGS } from "./e2eTest/constants.ts";

export default defineConfig({
  test: {
    include: ["e2eTest/**/**.test.ts"],
    setupFiles: ["./e2eTest/setup.ts"],
    tags: Object.values(TAGS).map((name) => ({ name })),
    reporters: ["verbose"],
  },
});
