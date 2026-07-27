#!/usr/bin/env node
// =============================================================================
// extract-cli-model.mjs  —  agentcore CLI -> doc-model JSON
// =============================================================================
// Runs `agentcore <cmd> --help` for every command, parses the Commander.js help
// output, and emits the SAME shared doc-model schema (v1) as the SDK extractors
// so the one shared renderer (_shared/render_adoc.py) produces consistent .adoc.
//
// Why --help scraping (not AST): it is 1:1 with what users actually see, and it
// survives refactors of the command source. Commander.js help is
// stable and easy to parse (Usage / Arguments / Options blocks).
//
// Decision: ALL ~30 commands, arranged into groups (one group == one .adoc).
//
// NOTE: if these workflows are later consolidated into a single shared reusable
// workflow, this script is vendored there and selected via `language: cli`.
// Standalone here for the draft.
// =============================================================================
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { argv } from 'node:process';
import { pathToFileURL } from 'node:url';

// Command grouping (arranged properly, per the request). Mirrors the sections
// in agentcore-cli/docs/commands.md. Any command discovered from the binary but
// not listed here lands in the "Other" group so nothing is silently dropped.
const GROUPS = [
  {
    id: 'project-lifecycle',
    title: 'Project Lifecycle',
    commands: ['create', 'deploy', 'dev', 'package', 'export', 'update', 'validate'],
  },
  {
    id: 'invocation',
    title: 'Invocation & Runtime',
    commands: ['invoke', 'exec', 'run', 'logs', 'traces', 'status', 'fetch', 'view'],
  },
  {
    id: 'resources',
    title: 'Resource Management',
    commands: ['add', 'remove', 'import'],
  },
  {
    id: 'evaluation',
    title: 'Evaluation & Datasets',
    commands: ['evals', 'batch-evaluations', 'dataset'],
  },
  {
    id: 'optimization',
    title: 'Optimization & Config Bundles',
    commands: ['config-bundle', 'promote', 'archive'],
  },
  {
    id: 'operations',
    title: 'Operations & Settings',
    commands: ['pause', 'resume', 'stop', 'config', 'telemetry', 'feedback'],
  },
];

// AGENTCORE_BIN may be a single command ("agentcore") OR a multi-token
// invocation ("node /path/to/index.mjs"). Split into [executable, ...prefixArgs]
// so execFileSync gets a real executable and forwards the rest as args —
// passing the whole string as argv[0] would make execFileSync look for an
// executable literally named "node /path/...", which fails silently to empty.
const BIN_TOKENS = (process.env.AGENTCORE_BIN || 'agentcore').split(/\s+/);
const BIN = BIN_TOKENS[0];
const BIN_PREFIX_ARGS = BIN_TOKENS.slice(1);

function getArg(flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

function help(args) {
  try {
    return execFileSync(BIN, [...BIN_PREFIX_ARGS, ...args, '--help'], {
      encoding: 'utf8',
      // CLI launches a TUI without args; --help forces non-interactive text.
      env: { ...process.env, NO_COLOR: '1', CI: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    // Commander exits non-zero for some help paths; stdout still holds text.
    return (e.stdout && e.stdout.toString()) || '';
  }
}

const PARAMETER_DESCRIPTION_OVERRIDES = new Map([
  ['bedrock, open_ai, or gemini', 'The model provider. Valid values: `bedrock`, `open_ai`, or `gemini`.'],
  [
    'Override LiteLLM API base URL (harness only, lite_llm) [non-interactive]',
    'The LiteLLM API base URL override for harness invocations. ' +
      'Available only with `lite_llm` in non-interactive mode.',
  ],
  [
    'Override LiteLLM additional params as a JSON object (harness only, lite_llm) [non-interactive]',
    'The additional LiteLLM parameters, as a JSON object, for harness invocations. ' +
      'Available only with `lite_llm` in non-interactive mode.',
  ],
]);

export function normalizeParameterDescription(description) {
  return PARAMETER_DESCRIPTION_OVERRIDES.get(description) || description;
}

// Parse a Commander.js help blob into { summary, signature, params, options }.
export function parseHelp(text) {
  const lines = text.split('\n');
  const out = { summary: '', signature: '', args: [], options: [] };
  let section = 'head';
  let currentItem = null;
  const descLines = [];

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (/^Usage:/.test(line)) {
      out.signature = line.replace(/^Usage:\s*/, '').trim();
      section = 'desc';
      currentItem = null;
      continue;
    }
    if (/^Arguments:/.test(line)) {
      section = 'args';
      currentItem = null;
      continue;
    }
    if (/^Options:/.test(line)) {
      section = 'options';
      currentItem = null;
      continue;
    }
    if (/^Commands:/.test(line)) {
      section = 'commands';
      currentItem = null;
      continue;
    }

    if (section === 'desc') {
      if (line.trim()) descLines.push(line.trim());
    } else if (section === 'args') {
      const m = line.match(/^\s+(\S+)\s{2,}(.*)$/);
      if (m) {
        currentItem = { name: m[1], type: null, required: true, description: m[2].trim() };
        out.args.push(currentItem);
      } else if (currentItem && /^\s+\S/.test(line)) {
        currentItem.description += ` ${line.trim()}`;
      }
    } else if (section === 'options') {
      const m = line.match(/^\s+(-[^\s].*?)\s{2,}(.*)$/);
      if (m) {
        currentItem = { name: m[1].trim(), type: null, required: false, description: m[2].trim() };
        out.options.push(currentItem);
      } else if (currentItem && /^\s+\S/.test(line)) {
        currentItem.description += ` ${line.trim()}`;
      } else if (line.trim()) {
        currentItem = null;
      }
    }
  }
  out.summary = descLines.join(' ');
  return out;
}

function entryForCommand(name) {
  const raw = help([name]);
  // Fail loudly on phantom commands / drift. A real command's help names itself
  // in the usage line (`Usage: agentcore <name> ...`); an unknown command falls
  // back to the root usage (`Usage: agentcore [options] [command]`), which does
  // NOT contain the name. Without this guard such commands would silently render
  // as empty stubs (synthesized signature, no description/params).
  if (!new RegExp(`^Usage:\\s+agentcore\\s+${name}\\b`, 'm').test(raw)) {
    throw new Error(
      `Command "${name}" produced no self-describing help output — it is likely ` +
        `not a real CLI command (phantom/renamed). Remove it from GROUPS or fix the name.`
    );
  }
  const parsed = parseHelp(raw);
  // subcommands (e.g. `add agent`, `remove tool`) show under "Commands:"—
  // we surface the top-level command; nested ones can be expanded later.
  return {
    kind: 'command',
    name: `agentcore ${name}`,
    signature: parsed.signature || `agentcore ${name} [options]`,
    summary: parsed.summary,
    description: '',
    // reuse params for both positional args and flags, flagged by required.
    // The renderer already wraps param names in backticks, so don't add our
    // own (that produced double-backticks). Drop the ubiquitous help flag.
    params: [...parsed.args, ...parsed.options.filter(o => !/^-h,?\s|--help\b/.test(o.name))].map(param => ({
      ...param,
      description: normalizeParameterDescription(param.description),
    })),
    returns: null,
    raises: [],
    examples: [],
    members: [],
  };
}

function discoverCommands() {
  // Parse the root help "Commands:" block so we don't miss anything new.
  // In Commander output, a command entry starts at EXACTLY 2 spaces of indent
  // (e.g. "  deploy|dp [options]  ...") while wrapped description lines are
  // indented much deeper (~36 spaces). Matching only the 2-space indent avoids
  // scraping the first word of a wrapped description ("locally", "past", ...).
  // We also strip the "|alias" and trailing "[options]"/"<arg>" tokens.
  const text = help([]);
  const found = [];
  let inCmds = false;
  for (const line of text.split('\n')) {
    if (/^Commands:/.test(line)) {
      inCmds = true;
      continue;
    }
    if (!inCmds) continue;
    // stop if we hit a new top-level section (e.g. a footer) — non-indented text
    if (line.trim() && !/^ {2}\S/.test(line) && !/^ {3,}/.test(line)) break;
    const m = line.match(/^ {2}([a-z][a-z0-9-]*)(?:\|[a-z0-9-]+)?\b/);
    if (m) found.push(m[1]);
  }
  return found;
}

function main() {
  const outPath = getArg('--out');
  const version = getArg('--version') || 'unknown';

  const discovered = new Set(discoverCommands());
  const placed = new Set();
  const groups = [];

  for (const g of GROUPS) {
    const entries = [];
    for (const cmd of g.commands) {
      entries.push(entryForCommand(cmd));
      placed.add(cmd);
    }
    groups.push({ id: g.id, title: g.title, summary: '', entries });
  }

  // Built-in meta-commands we intentionally don't document as API surface.
  const IGNORED = new Set(['help']);

  // Catch anything the binary exposes that we didn't group — no silent drops.
  const leftovers = [...discovered].filter(c => !placed.has(c) && !IGNORED.has(c));
  if (leftovers.length) {
    process.stderr.write(`WARNING: ungrouped commands -> "Other": ${leftovers.join(', ')}\n`);
    groups.push({
      id: 'other',
      title: 'Other Commands',
      summary: '',
      entries: leftovers.map(entryForCommand),
    });
  }

  const model = {
    source: 'cli',
    package: '@aws/agentcore',
    version,
    language: 'cli',
    groups,
  };
  writeFileSync(outPath, JSON.stringify(model, null, 2));
  process.stderr.write(`Wrote doc-model: ${groups.length} groups, version ${version}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
