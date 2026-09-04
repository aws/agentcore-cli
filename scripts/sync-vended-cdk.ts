#!/usr/bin/env bun

import { $ } from "bun";
import { join, resolve } from "node:path";
import { runWithExitCode } from "../src/runnable";

const CDK_PACKAGE = "@aws/agentcore-cdk";
const TEMPLATE = Bun.file(
  join(resolve(import.meta.dir, ".."), "src", "assets", "cdk", "package.json"),
);

process.exit(
  await runWithExitCode(async (argv) => {
    const tag = argv[2] ?? "latest";
    const target = (await $`bun pm view ${CDK_PACKAGE}@${tag} version`.text()).trim();
    const template = await TEMPLATE.json();
    const current = template.dependencies[CDK_PACKAGE];
    if (current === target) {
      console.log(`${CDK_PACKAGE} already pinned to ${target}`);
      return;
    }
    template.dependencies[CDK_PACKAGE] = target;
    await Bun.write(TEMPLATE, JSON.stringify(template, null, 2) + "\n");
    console.log(`${CDK_PACKAGE}: ${current} → ${target}`);
  }),
);
