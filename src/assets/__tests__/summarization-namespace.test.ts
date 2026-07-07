/**
 * Regression test for cross-session SUMMARIZATION recall (issue #665).
 *
 * The SUMMARIZATION retrieval namespace must be actor-scoped (`/summaries/{actor_id}`),
 * not session-scoped. The SDK's namespace_path is a hierarchical prefix match, so a
 * per-session prefix (`/summaries/{actor_id}/{session_id}`) only ever matches the current
 * session's own summaries and never surfaces summaries written by prior sessions —
 * silently breaking cross-session recall. This guards against another silent revert
 * (see PR #1299, reverted by squash release #1547).
 */
import Handlebars from 'handlebars';
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
// Importing render registers the `includes` Handlebars helper used by the template.
import '../../cli/templates/render.js';

const FLAVORS = ['http', 'agui', 'a2a'] as const;

function renderSessionTemplate(flavor: string): string {
  const templatePath = path.resolve(
    __dirname,
    '..',
    'python',
    flavor,
    'strands',
    'capabilities',
    'memory',
    'session.py'
  );
  const content = fs.readFileSync(templatePath, 'utf-8');
  return Handlebars.compile(content)({
    memoryProviders: [{ envVarName: 'MEMORY_TEST_ID', strategies: ['SUMMARIZATION'] }],
  });
}

describe('SUMMARIZATION retrieval namespace', () => {
  it.each(FLAVORS)('%s session.py uses an actor-scoped summary namespace', flavor => {
    const rendered = renderSessionTemplate(flavor);
    expect(rendered).toContain('f"/summaries/{actor_id}": RetrievalConfig');
    expect(rendered).not.toContain('/summaries/{actor_id}/{session_id}');
  });
});
