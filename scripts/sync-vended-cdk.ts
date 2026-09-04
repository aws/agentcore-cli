#!/usr/bin/env bun

/**
 Pins the vended CDK template to the published @aws/agentcore-cdk at the given dist-tag (default latest).
 Runs before bun install in release-prepare.yml, so it must not import anything from src/.
**/

import { $ } from "bun";
import { join, resolve } from "node:path";

const CDK_PACKAGE = "@aws/agentcore-cdk";
const TEMPLATE = Bun.file(
  join(resolve(import.meta.dir, ".."), "src", "assets", "cdk", "package.json"),
);

const tag = Bun.argv[2] ?? "latest";
const target = (await $`bun pm view ${CDK_PACKAGE}@${tag} version`.text()).trim();
const template = await TEMPLATE.json();
const current = template.dependencies[CDK_PACKAGE];

if (current === target) {
  console.log(`${CDK_PACKAGE} already pinned to ${target}`);
} else {
  template.dependencies[CDK_PACKAGE] = target;
  await Bun.write(TEMPLATE, JSON.stringify(template, null, 2) + "\n");
  console.log(`${CDK_PACKAGE}: ${current} → ${target}`);
}
