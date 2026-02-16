import { buildLogo } from '../LayoutContext.js';
import { describe, expect, it } from 'vitest';

describe('buildLogo', () => {
  it('builds logo with correct width', () => {
    const logo = buildLogo(40);

    expect(logo).toContain('>_ AgentCore');
    expect(logo).toContain('┌');
    expect(logo).toContain('┐');
    expect(logo).toContain('└');
    expect(logo).toContain('┘');
  });

  it('includes version when provided', () => {
    const logo = buildLogo(50, '1.2.3');

    expect(logo).toContain('>_ AgentCore');
    expect(logo).toContain('v1.2.3');
  });

  it('does not include version when not provided', () => {
    const logo = buildLogo(40);

    expect(logo).not.toContain('v');
  });

  it('handles narrow width without crashing', () => {
    const logo = buildLogo(20);

    expect(logo).toContain('>_ AgentCore');
  });
});
