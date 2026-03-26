/**
 * Unit tests for the SVG renderer.
 *
 * Each test creates its own Terminal instance to avoid shared state.
 * terminal.write() is async internally -- we wait 50ms after each write
 * to give xterm a tick to process.
 */
import { DARK_THEME, LIGHT_THEME, renderTerminalToSvg } from '../lib/svg-renderer.js';
import xtermHeadless from '@xterm/headless';
import { afterEach, describe, expect, it } from 'vitest';

const { Terminal } = xtermHeadless;

describe('SVG renderer', () => {
  let terminal: InstanceType<typeof Terminal>;

  afterEach(() => {
    terminal?.dispose();
  });

  it('renders a basic SVG from a terminal with text', async () => {
    terminal = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    terminal.write('Hello World');
    await new Promise(resolve => setTimeout(resolve, 50));

    const svg = renderTerminalToSvg(terminal);

    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg.endsWith('</svg>')).toBe(true);
    expect(svg).toContain('Hello World');
    expect(svg).toContain('<rect');
  });

  it('includes window chrome when showWindowChrome is true', async () => {
    terminal = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    terminal.write('test');
    await new Promise(resolve => setTimeout(resolve, 50));

    const svg = renderTerminalToSvg(terminal, { showWindowChrome: true });

    expect(svg).toContain('#ff5f56');
    expect(svg).toContain('#ffbd2e');
    expect(svg).toContain('#27c93f');
  });

  it('omits window chrome when showWindowChrome is false', async () => {
    terminal = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    terminal.write('test');
    await new Promise(resolve => setTimeout(resolve, 50));

    const svg = renderTerminalToSvg(terminal, { showWindowChrome: false });

    expect(svg).not.toContain('#ff5f56');
    expect(svg).not.toContain('#ffbd2e');
    expect(svg).not.toContain('#27c93f');
  });

  it('uses light theme when specified', async () => {
    terminal = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    terminal.write('test');
    await new Promise(resolve => setTimeout(resolve, 50));

    const svg = renderTerminalToSvg(terminal, { theme: LIGHT_THEME });

    expect(svg).toContain('#ffffff');
  });

  it('uses dark theme by default', async () => {
    terminal = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    terminal.write('test');
    await new Promise(resolve => setTimeout(resolve, 50));

    const svg = renderTerminalToSvg(terminal);

    expect(svg).toContain('#1e1e1e');
  });

  it('includes cursor when showCursor is true', async () => {
    terminal = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    terminal.write('test');
    await new Promise(resolve => setTimeout(resolve, 50));

    const svg = renderTerminalToSvg(terminal, { showCursor: true });

    expect(svg).toContain(DARK_THEME.cursor);
    expect(svg).toContain('opacity="0.7"');
  });

  it('handles special XML characters', async () => {
    terminal = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    terminal.write('<div>&"test"</div>');
    await new Promise(resolve => setTimeout(resolve, 50));

    const svg = renderTerminalToSvg(terminal);

    expect(svg).toContain('&lt;div&gt;');
    expect(svg).toContain('&amp;');
    // Must not contain raw unescaped characters in the text content
    expect(svg).not.toMatch(/<div>[^<]*&"test"[^<]*<\/div>/);
  });

  it('respects custom title in window chrome', async () => {
    terminal = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    terminal.write('test');
    await new Promise(resolve => setTimeout(resolve, 50));

    const svg = renderTerminalToSvg(terminal, { title: 'My Terminal' });

    expect(svg).toContain('My Terminal');
  });

  it('preserves whitespace and uses textLength for precise character positioning', async () => {
    terminal = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    terminal.write('test');
    await new Promise(resolve => setTimeout(resolve, 50));

    const svg = renderTerminalToSvg(terminal);

    // Both CSS white-space:pre and xml:space="preserve" prevent whitespace collapse
    expect(svg).toContain('white-space: pre');
    expect(svg).toContain('xml:space="preserve"');
    // Must use textLength + lengthAdjust for font-independent character grid alignment
    expect(svg).toContain('textLength=');
    expect(svg).toContain('lengthAdjust="spacing"');
    // Tspans must be inline within <text> — no newlines that white-space:pre would render
    expect(svg).not.toMatch(/<text[^>]*>\n/);
  });
});
