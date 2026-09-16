#!/usr/bin/env bun

import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIR, "..");
const DEFAULT_GROUPS = [
  { id: "global-options", title: "Global options", commands: [] },
  { id: "project", title: "Project commands", commands: ["project"] },
  { id: "harness", title: "Harness commands", commands: ["harness"] },
  { id: "identity", title: "Identity commands", commands: ["identity"] },
  { id: "runtime", title: "Runtime commands", commands: ["runtime"] },
  { id: "memory", title: "Memory commands", commands: ["memory"] },
  { id: "gateway", title: "Gateway commands", commands: ["gateway"] },
  { id: "payment", title: "Payment commands", commands: ["payment"] },
  { id: "evaluation", title: "Evaluation commands", commands: ["eval"] },
  {
    id: "settings",
    title: "CLI settings and feedback",
    commands: ["feedback", "config", "update"],
  },
];
const BIN_TOKENS = process.env.AGENTCORE_BIN
  ? process.env.AGENTCORE_BIN.split(/\s+/).filter(Boolean)
  : ["bun", resolve(REPOSITORY_ROOT, "src/index.ts")];
const BIN = BIN_TOKENS[0];
const BIN_PREFIX_ARGS = BIN_TOKENS.slice(1);

function getArg(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function commandHelp(path) {
  const result = Bun.spawnSync({
    cmd: [BIN, ...BIN_PREFIX_ARGS, ...path, "--help"],
    env: {
      ...process.env,
      NO_COLOR: "1",
      CI: "1",
      AGENTCORE_TELEMETRY_DISABLED: "1",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = result.stdout.toString();
  if (stdout) return stdout;

  throw new Error(
    `Could not read help for "agentcore ${path.join(" ")}": ${result.stderr.toString().trim()}`,
  );
}

function isSectionHeading(line) {
  return /^[A-Z][^:]*:$/.test(line.trim());
}

function isOptionSection(section) {
  return (
    section !== "global options" &&
    section !== "commands" &&
    section !== "parameter details" &&
    section !== "description"
  );
}

function parseHelp(text) {
  const parsed = {
    summary: "",
    signature: "",
    args: [],
    options: [],
    commands: [],
  };
  const descriptionLines = [];
  let section = "head";
  let currentItem;

  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    const trimmed = line.trim();

    if (line.startsWith("Usage:")) {
      parsed.signature = line.replace(/^Usage:\s*/, "").trim();
      section = "description";
      currentItem = undefined;
      continue;
    }

    if (isSectionHeading(line)) {
      section = trimmed.slice(0, -1).toLowerCase();
      currentItem = undefined;
      continue;
    }

    if (section === "description") {
      if (trimmed) descriptionLines.push(trimmed);
      continue;
    }

    if (section === "arguments") {
      const match = line.match(/^\s+(\S+)\s{2,}(.*)$/);
      if (match) {
        currentItem = {
          name: match[1],
          required: !match[1].startsWith("["),
          description: match[2].trim(),
        };
        parsed.args.push(currentItem);
      } else if (currentItem && /^\s+\S/.test(line)) {
        currentItem.description += ` ${trimmed}`;
      }
      continue;
    }

    if (section === "commands") {
      const match = line.match(/^ {2}([a-z][a-z0-9-]*)\b(?:\s{2,}.*)?$/);
      if (match) parsed.commands.push(match[1]);
      continue;
    }

    if (isOptionSection(section)) {
      const match = line.match(/^\s+(-[^\s].*?)\s{2,}(.*)$/);
      if (match) {
        currentItem = {
          name: match[1].trim(),
          required: false,
          description: match[2].trim(),
        };
        parsed.options.push(currentItem);
      } else if (currentItem && /^\s+\S/.test(line)) {
        currentItem.description += ` ${trimmed}`;
      } else if (trimmed) {
        currentItem = undefined;
      }
    }
  }

  parsed.summary = descriptionLines.join(" ");
  const optionalArguments = new Set(
    [...parsed.signature.matchAll(/\[([a-z0-9-]+)(?:\.\.\.)?\]/gi)].map((match) => match[1]),
  );
  for (const argument of parsed.args) {
    argument.required = !optionalArguments.has(argument.name);
  }
  return parsed;
}

function expectedUsage(path) {
  return `agentcore${path.length ? ` ${path.join(" ")}` : ""}`;
}

function isHelpOption(option) {
  return /(?:^|,\s*)-h\b|--help\b/.test(option.name);
}

function entryForCommand(path) {
  const parsed = parseHelp(commandHelp(path));
  const usagePrefix = expectedUsage(path);

  if (!parsed.signature.startsWith(usagePrefix)) {
    throw new Error(
      `Help for "${usagePrefix}" returned the unexpected usage "${parsed.signature}".`,
    );
  }

  return {
    name: usagePrefix,
    signature: parsed.signature,
    summary: parsed.summary,
    params: [...parsed.args, ...parsed.options.filter((option) => !isHelpOption(option))],
    members: parsed.commands.map((command) => entryForCommand([...path, command])),
  };
}

function buildModel({ version, groups = DEFAULT_GROUPS }) {
  const rootEntry = entryForCommand([]);
  const discovered = new Set(rootEntry.members.map((entry) => entry.name.split(" ").at(-1)));
  const grouped = new Set(groups.flatMap((group) => group.commands));
  const missing = [...discovered].filter((command) => !grouped.has(command));
  const unknown = [...grouped].filter((command) => !discovered.has(command));

  if (missing.length) {
    throw new Error(`Top-level commands missing from groups: ${missing.join(", ")}`);
  }
  if (unknown.length) {
    throw new Error(`Grouped commands not found in CLI help: ${unknown.join(", ")}`);
  }

  const entriesByCommand = new Map(
    rootEntry.members.map((entry) => [entry.name.split(" ").at(-1), entry]),
  );

  return {
    version,
    groups: groups.map((group) => ({
      title: group.title,
      entries:
        group.id === "global-options"
          ? [{ ...rootEntry, members: [] }]
          : group.commands.map((command) => entriesByCommand.get(command)),
    })),
  };
}

function normalizeText(text) {
  return (text || "")
    .replaceAll(" \u2014 ", ": ")
    .replaceAll("`", "\\`")
    .replaceAll("*", "\\*")
    .replaceAll("_", "\\_")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function markdownAnchor(heading) {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

function renderTableOfContentsCommand(entry, depth, output) {
  const indentation = "  ".repeat(depth);
  output.push(`${indentation}- [\`${entry.name}\`](#${markdownAnchor(entry.name)})`);

  for (const member of entry.members || []) {
    renderTableOfContentsCommand(member, depth + 1, output);
  }
}

function renderParameters(params, output) {
  const argumentsList = params.filter((param) => !param.name.startsWith("-"));
  const options = params.filter((param) => param.name.startsWith("-"));

  if (argumentsList.length) {
    output.push("**Arguments**", "");
    for (const argument of argumentsList) {
      const requirement = argument.required ? "required" : "optional";
      const description = normalizeText(argument.description) || "No description.";
      output.push(`- \`${argument.name}\` (${requirement}): ${description}`);
    }
    output.push("");
  }

  if (options.length) {
    output.push("**Options**", "");
    for (const option of options) {
      const description = normalizeText(option.description) || "No description.";
      output.push(`- \`${option.name}\`: ${description}`);
    }
    output.push("");
  }
}

function renderCommand(entry, headingLevel, output) {
  const heading = "#".repeat(headingLevel);
  output.push(`${heading} \`${entry.name}\``, "");
  output.push("```text", entry.signature, "```", "");

  if (entry.summary) {
    output.push(normalizeText(entry.summary), "");
  }

  renderParameters(entry.params || [], output);

  for (const member of entry.members || []) {
    renderCommand(member, headingLevel + 1, output);
  }
}

function renderMarkdown(model) {
  const output = [
    "<!-- Generated by scripts/generate-command-reference.mjs. Do not edit directly. -->",
    "",
    "# AgentCore CLI command reference",
    "",
    `This reference was generated from \`agentcore --help\` for version \`${model.version}\`.`,
    "",
    "## Table of contents",
    "",
  ];

  for (const group of model.groups) {
    output.push(`- [${group.title}](#${markdownAnchor(group.title)})`);
    for (const entry of group.entries) {
      renderTableOfContentsCommand(entry, 1, output);
    }
  }
  output.push("");

  for (const group of model.groups) {
    output.push(`## ${group.title}`, "");
    for (const entry of group.entries) {
      renderCommand(entry, 3, output);
    }
  }

  return `${output.join("\n").trim()}\n`;
}

async function packageVersion() {
  const packageJson = await Bun.file(resolve(REPOSITORY_ROOT, "package.json")).json();
  return packageJson.version;
}

async function main() {
  const outPath = resolve(REPOSITORY_ROOT, getArg("--out") || "command.md");
  const model = buildModel({ version: await packageVersion() });
  await Bun.write(outPath, renderMarkdown(model));

  const commandCount = model.groups
    .flatMap((group) => group.entries)
    .reduce(function count(total, entry) {
      return total + 1 + entry.members.reduce(count, 0);
    }, 0);

  process.stderr.write(`Wrote ${outPath} with ${commandCount} commands\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
