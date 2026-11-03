import { defineConfig } from "vitest/config";
import { TAGS } from "./e2eTest/constants";

// This focused suite cleans up only the stacks it creates.
export default defineConfig({
  test: {
    include: ["e2eTest/project/prebuilt-runtime.test.ts"],
    tags: [{ name: TAGS.RUNTIME }],
    reporters: ["verbose"],
  },
});
