import { BaseRenderer } from '../BaseRenderer.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mockCopyAndRenderDir = vi.fn();
const mockExistsSync = vi.fn();

vi.mock('../render.js', () => ({
  copyAndRenderDir: (...args: unknown[]) => mockCopyAndRenderDir(...args),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual('node:fs');
  return { ...actual, existsSync: (...args: unknown[]) => mockExistsSync(...args) };
});

vi.mock('../../../lib', () => ({
  APP_DIR: 'app',
}));

class TestRenderer extends BaseRenderer {
  constructor(config: any, sdkName: string, baseTemplateDir: string) {
    super(config, sdkName, baseTemplateDir);
  }

  getTemplateDirPublic(): string {
    return this.getTemplateDir();
  }
}

describe('BaseRenderer', () => {
  afterEach(() => vi.clearAllMocks());

  it('getTemplateDir joins language and sdk name', () => {
    const renderer = new TestRenderer(
      { targetLanguage: 'Python', name: 'MyAgent', hasMemory: false },
      'strands',
      '/templates'
    );

    expect(renderer.getTemplateDirPublic()).toBe('/templates/python/strands');
  });

  it('render copies base template', async () => {
    mockCopyAndRenderDir.mockResolvedValue(undefined);
    mockExistsSync.mockReturnValue(false);

    const renderer = new TestRenderer(
      { targetLanguage: 'Python', name: 'MyAgent', hasMemory: false },
      'strands',
      '/templates'
    );

    await renderer.render({ outputDir: '/output' });

    expect(mockCopyAndRenderDir).toHaveBeenCalledTimes(1);
    expect(mockCopyAndRenderDir).toHaveBeenCalledWith(
      '/templates/python/strands/base',
      '/output/app/MyAgent',
      expect.objectContaining({ projectName: 'MyAgent', Name: 'MyAgent', hasMcp: false })
    );
  });

  it('render copies memory capability when hasMemory and dir exists', async () => {
    mockCopyAndRenderDir.mockResolvedValue(undefined);
    mockExistsSync.mockReturnValue(true);

    const renderer = new TestRenderer(
      { targetLanguage: 'TypeScript', name: 'Agent', hasMemory: true },
      'langchain',
      '/templates'
    );

    await renderer.render({ outputDir: '/out' });

    expect(mockCopyAndRenderDir).toHaveBeenCalledTimes(2);
    expect(mockCopyAndRenderDir).toHaveBeenCalledWith(
      '/templates/typescript/langchain/capabilities/memory',
      '/out/app/Agent/memory',
      expect.objectContaining({ projectName: 'Agent', hasMemory: true })
    );
  });

  it('render skips memory capability when dir does not exist', async () => {
    mockCopyAndRenderDir.mockResolvedValue(undefined);
    mockExistsSync.mockReturnValue(false);

    const renderer = new TestRenderer(
      { targetLanguage: 'Python', name: 'Agent', hasMemory: true },
      'strands',
      '/templates'
    );

    await renderer.render({ outputDir: '/out' });

    expect(mockCopyAndRenderDir).toHaveBeenCalledTimes(1);
  });
});
