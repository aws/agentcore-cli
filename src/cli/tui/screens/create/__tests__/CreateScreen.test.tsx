import { CreateScreen } from '../CreateScreen';
import { mkdtempSync, rmSync } from 'fs';
import { render } from 'ink-testing-library';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const ENTER = '\r';
const ESCAPE = '\x1B';
const delay = (ms = 50) => new Promise(resolve => setTimeout(resolve, ms));

let testDir: string | undefined;

afterEach(() => {
  if (testDir) {
    rmSync(testDir, { recursive: true, force: true });
    testDir = undefined;
  }
});

describe('CreateScreen navigation', () => {
  it('returns to project name input when Escape is pressed on the create type prompt', async () => {
    testDir = mkdtempSync(join(tmpdir(), 'agentcore-create-screen-'));
    const onExit = vi.fn();
    const { lastFrame, stdin } = render(<CreateScreen cwd={testDir} isInteractive={false} onExit={onExit} />);

    await delay();
    stdin.write('TestProject');
    await delay();
    stdin.write(ENTER);
    await delay();

    expect(lastFrame()).toContain('What would you like to build?');
    expect(lastFrame()).toContain('Esc back');

    stdin.write(ESCAPE);
    await delay();

    expect(lastFrame()).toContain('Create a new AgentCore project');
    expect(lastFrame()).toContain('Project name');
    expect(onExit).not.toHaveBeenCalled();
  });
});
