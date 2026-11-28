import { defineConfig } from "vitest/config";
import { TAGS } from "./e2eTest/constants.ts";

export default defineConfig({
  test: {
    include: ["e2eTest/**/**.test.ts"],
    setupFiles: ["./e2eTest/setup.ts"],
    tags: Object.values(TAGS).map((name) => ({ name })),
    reporters: ["verbose"],
    // The tests wait on AWS, not the CPU: run every test file at once, also on a runner with few
    // CPUs, where Vitest would otherwise run one or two files at a time.
    maxWorkers: 8,
  },
});
