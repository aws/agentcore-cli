import { getCdkProjectDir } from '../teardown.js';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

describe('getCdkProjectDir', () => {
  it('returns agentcore/cdk under cwd by default', () => {
    const result = getCdkProjectDir();

    expect(result).toBe(join(process.cwd(), 'agentcore', 'cdk'));
  });

  it('returns agentcore/cdk under custom directory', () => {
    const result = getCdkProjectDir('/custom/path');

    expect(result).toBe(join('/custom/path', 'agentcore', 'cdk'));
  });
});
