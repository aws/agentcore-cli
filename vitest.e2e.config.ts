import { defineConfig } from "vitest/config";
import { TAGS } from "./test/constants.ts";

export default defineConfig({
  test: {
    include: ["test/**/**.test.ts"],
    setupFiles: ["./test/setup.ts"],
    tags: Object.values(TAGS).map((name) => ({ name })),
    reporters: ["verbose"],
  },
});
