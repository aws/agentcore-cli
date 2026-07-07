/**
 * Creates a GitHub issue for an automated failure. Ex. Canary failure.
 *
 * Usage:
 *   npx tsx .github/scripts/create-failure-issue.ts \
 *     --title-prefix "CI Failure" \
 *     --name "Build and Test" \
 *     --branch main \
 *     --commit <sha> \
 *     --run-url <url> \
 *     [--labels high-severity,ci] \
 *     [--detail "Variant: Released/Preview"]
 *
 * Required env:
 *   GH_TOKEN (or GITHUB_TOKEN)  — token with `issues: write`
 *   GITHUB_REPOSITORY           — "owner/repo" (auto-set by GitHub Actions)
 *
 */

const GITHUB_API_BASE_URL = 'https://api.github.com';

interface CreateIssueArgs {
  titlePrefix: string;
  name: string;
  branch: string;
  commit: string;
  runUrl: string;
  labels: string[];
  detail?: string;
}

function parseArgs(argv: string[]): CreateIssueArgs {
  const map = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`Missing value for --${key}`);
      }
      map.set(key, value);
      i++;
    }
  }

  const required = ['title-prefix', 'name', 'commit', 'run-url'];
  const missing = required.filter(k => !map.get(k));
  if (missing.length > 0) {
    throw new Error(`Missing required arguments: ${missing.map(k => `--${k}`).join(', ')}`);
  }

  return {
    titlePrefix: map.get('title-prefix')!,
    name: map.get('name')!,
    branch: map.get('branch') ?? 'main',
    commit: map.get('commit')!,
    runUrl: map.get('run-url')!,
    labels: (map.get('labels') ?? 'high-severity,ci')
      .split(',')
      .map(l => l.trim())
      .filter(Boolean),
    detail: map.get('detail'),
  };
}

function getRepo(): { owner: string; repo: string } {
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository || !repository.includes('/')) {
    throw new Error('GITHUB_REPOSITORY env var must be set to "owner/repo"');
  }
  const [owner, repo] = repository.split('/');
  return { owner, repo };
}

function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'agentcore-cli-failure-issue-script',
  };
}

async function ghFetch(url: string, token: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, {
    ...init,
    headers: { ...ghHeaders(token), ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API ${init?.method ?? 'GET'} ${url} failed: ${res.status} ${res.statusText} — ${text}`);
  }
  return res.json();
}

interface IssueItem {
  title: string;
}

async function issueExists(owner: string, repo: string, title: string, token: string): Promise<boolean> {
  // Primary: search index (fast, but can be stale).
  const q = encodeURIComponent(`repo:${owner}/${repo} is:issue is:open in:title "${title}"`);
  const search = (await ghFetch(`${GITHUB_API_BASE_URL}/search/issues?q=${q}`, token)) as { items?: IssueItem[] };
  if ((search.items ?? []).some(i => i.title === title)) {
    return true;
  }

  // Fallback: scan recent open issues in case the search index is stale.
  const recent = (await ghFetch(
    `${GITHUB_API_BASE_URL}/repos/${owner}/${repo}/issues?state=open&sort=created&direction=desc&per_page=30`,
    token
  )) as IssueItem[];
  return recent.some(i => i.title === title);
}

async function main(): Promise<void> {
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error('GH_TOKEN (or GITHUB_TOKEN) env var is required');
  }

  const args = parseArgs(process.argv.slice(2));
  console.log(`args: ${JSON.stringify(args)}`);
  const { owner, repo } = getRepo();

  const titleField = `${args.titlePrefix}: ${args.name}`;

  if (await issueExists(owner, repo, titleField, token)) {
    console.log(`Issue already exists for "${titleField}" — skipping creation.`);
    return;
  }

  const bodyLines = [
    `## ${args.titlePrefix}`,
    '',
    `- **Name:** ${args.name}`,
    `- **Branch:** ${args.branch}`,
    `- **Commit:** ${args.commit}`,
    `- **Run:** ${args.runUrl}`,
  ];
  if (args.detail) {
    bodyLines.push(`- **Detail:** ${args.detail}`);
  }
  bodyLines.push('', 'Please investigate this failure.');

  await ghFetch(`${GITHUB_API_BASE_URL}/repos/${owner}/${repo}/issues`, token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: titleField,
      labels: args.labels,
      body: bodyLines.join('\n'),
    }),
  });

  console.log(`Created issue "${titleField}".`);
}

main().catch((error: unknown) => {
  console.error(`Failed to create failure issue: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
