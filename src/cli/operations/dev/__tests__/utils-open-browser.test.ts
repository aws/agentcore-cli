import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockUnref = vi.fn();
const mockSpawn = vi.fn().mockReturnValue({ unref: mockUnref });

vi.mock('child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

describe('openBrowser', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    mockSpawn.mockClear();
    mockUnref.mockClear();
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('uses "open" on macOS', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const { openBrowser } = await import('../utils');
    openBrowser('http://localhost:3000');

    expect(mockSpawn).toHaveBeenCalledWith('open', ['http://localhost:3000'], {
      stdio: 'ignore',
      detached: true,
    });
    expect(mockUnref).toHaveBeenCalled();
  });

  it('uses "cmd /c start" on Windows to avoid ENOENT', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const { openBrowser } = await import('../utils');
    openBrowser('http://localhost:3000');

    expect(mockSpawn).toHaveBeenCalledWith('cmd', ['/c', 'start', 'http://localhost:3000'], {
      stdio: 'ignore',
      detached: true,
    });
    expect(mockUnref).toHaveBeenCalled();
  });

  it('uses "xdg-open" on Linux', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const { openBrowser } = await import('../utils');
    openBrowser('http://localhost:3000');

    expect(mockSpawn).toHaveBeenCalledWith('xdg-open', ['http://localhost:3000'], {
      stdio: 'ignore',
      detached: true,
    });
    expect(mockUnref).toHaveBeenCalled();
  });
});
