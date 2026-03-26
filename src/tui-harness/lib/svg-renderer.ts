/**
 * SVG renderer for converting an @xterm/headless Terminal buffer into a visual
 * SVG screenshot.
 *
 * This module walks the terminal buffer cell-by-cell, resolves colors and text
 * attributes, groups consecutive cells with identical styles into spans, and
 * emits a self-contained SVG document. The output follows the visual style
 * pioneered by Rich and Textual (Python TUI projects): a monospace grid with
 * colored text and backgrounds, optional macOS-style window chrome, and a
 * blinking cursor overlay.
 *
 * The SVG is fully self-contained with no external dependencies, making it
 * safe to embed in GitHub markdown via an `<img>` tag.
 */
import xtermHeadless from '@xterm/headless';

const { Terminal } = xtermHeadless;
type Terminal = InstanceType<typeof Terminal>;

/**
 * Derived type for an xterm buffer cell. The `IBufferCell` interface is not
 * directly exported from `@xterm/headless`, so we derive it from the return
 * type of `IBuffer.getNullCell()`.
 */
type BufferCell = ReturnType<Terminal['buffer']['active']['getNullCell']>;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Color theme for SVG rendering.
 *
 * @property name - Human-readable theme name.
 * @property background - Default background color (hex).
 * @property foreground - Default foreground/text color (hex).
 * @property cursor - Cursor overlay color (hex).
 * @property palette - 16-color ANSI palette (indices 0-15). Colors 0-7 are
 *   the standard colors; 8-15 are their bright variants.
 */
export interface SvgTheme {
  name: string;
  background: string;
  foreground: string;
  cursor: string;
  palette: string[];
}

/**
 * Options for controlling the SVG rendering output.
 *
 * @property theme - Color theme. Defaults to {@link DARK_THEME}.
 * @property fontSize - Font size in pixels. Defaults to 14.
 * @property fontFamily - CSS font-family string. Defaults to
 *   `'Menlo, Monaco, Courier New, monospace'`.
 * @property showCursor - Whether to draw a cursor rectangle. Defaults to true.
 * @property showWindowChrome - Whether to draw a macOS-style title bar with
 *   colored dots. Defaults to true.
 * @property title - Title text shown in the window chrome.
 * @property padding - Padding around the terminal content in pixels. Defaults
 *   to 10.
 * @property borderRadius - Border radius for the outer rectangle. Defaults to 8.
 */
export interface SvgRenderOptions {
  theme?: SvgTheme;
  fontSize?: number;
  fontFamily?: string;
  showCursor?: boolean;
  showWindowChrome?: boolean;
  title?: string;
  padding?: number;
  borderRadius?: number;
}

// ---------------------------------------------------------------------------
// Built-in themes
// ---------------------------------------------------------------------------

/** Dark theme inspired by VS Code Dark+. */
export const DARK_THEME: SvgTheme = {
  name: 'dark',
  background: '#1e1e1e',
  foreground: '#d4d4d4',
  cursor: '#aeafad',
  palette: [
    '#000000',
    '#cd3131',
    '#0dbc79',
    '#e5e510',
    '#2472c8',
    '#bc3fbc',
    '#11a8cd',
    '#e5e5e5',
    '#666666',
    '#f14c4c',
    '#23d18b',
    '#f5f543',
    '#3b8eea',
    '#d670d6',
    '#29b8db',
    '#e5e5e5',
  ],
};

/** Light theme with GitHub-friendly colors. */
export const LIGHT_THEME: SvgTheme = {
  name: 'light',
  background: '#ffffff',
  foreground: '#24292e',
  cursor: '#044289',
  palette: [
    '#24292e',
    '#cf222e',
    '#116329',
    '#4d2d00',
    '#0550ae',
    '#8250df',
    '#1b7c83',
    '#6e7781',
    '#57606a',
    '#a40e26',
    '#1a7f37',
    '#633c01',
    '#0969da',
    '#8250df',
    '#3192aa',
    '#8c959f',
  ],
};

// ---------------------------------------------------------------------------
// ANSI 256-color palette
// ---------------------------------------------------------------------------

/**
 * Convert an ANSI 256-color palette index (16-255) to a hex color string.
 *
 * - Indices 16-231: 6x6x6 color cube. The index maps to RGB components via
 *   `16 + 36*r + 6*g + b` where r, g, b are in [0, 5]. Each component maps
 *   to a brightness value in [0, 55, 95, 135, 175, 215, 255].
 * - Indices 232-255: Grayscale ramp from dark (#080808) to light (#eeeeee).
 *
 * @param index - A palette index in the range 16-255.
 * @returns A hex color string like `#af00d7`.
 */
function ansi256ToHex(index: number): string {
  if (index >= 232) {
    // Grayscale ramp: 24 shades from 8 to 238
    const gray = (index - 232) * 10 + 8;
    return `#${gray.toString(16).padStart(2, '0').repeat(3)}`;
  }

  // 6x6x6 color cube
  const cubeIndex = index - 16;
  const b = cubeIndex % 6;
  const g = Math.floor(cubeIndex / 6) % 6;
  const r = Math.floor(cubeIndex / 36);

  const CUBE_VALUES = [0, 0x5f, 0x87, 0xaf, 0xd7, 0xff];
  const rv = CUBE_VALUES[r]!;
  const gv = CUBE_VALUES[g]!;
  const bv = CUBE_VALUES[b]!;

  return '#' + rv.toString(16).padStart(2, '0') + gv.toString(16).padStart(2, '0') + bv.toString(16).padStart(2, '0');
}

// ---------------------------------------------------------------------------
// Color resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the foreground or background color of a buffer cell to a hex string.
 *
 * Returns `null` when the cell uses the default color mode, signaling that the
 * theme's default foreground or background should be used instead.
 *
 * @param cell - The buffer cell to inspect.
 * @param type - Whether to resolve the `'fg'` (foreground) or `'bg'` (background) color.
 * @param theme - The active theme, used for palette indices 0-15.
 * @returns A hex color string, or `null` for the default color.
 */
function resolveColor(cell: BufferCell, type: 'fg' | 'bg', theme: SvgTheme): string | null {
  const isDefault = type === 'fg' ? cell.isFgDefault() : cell.isBgDefault();
  if (isDefault) return null;

  const isPalette = type === 'fg' ? cell.isFgPalette() : cell.isBgPalette();
  const isRGB = type === 'fg' ? cell.isFgRGB() : cell.isBgRGB();
  const colorValue = type === 'fg' ? cell.getFgColor() : cell.getBgColor();

  if (isPalette) {
    if (colorValue < 16) return theme.palette[colorValue] ?? null;
    return ansi256ToHex(colorValue);
  }

  if (isRGB) {
    const rr = ((colorValue >> 16) & 0xff).toString(16).padStart(2, '0');
    const gg = ((colorValue >> 8) & 0xff).toString(16).padStart(2, '0');
    const bb = (colorValue & 0xff).toString(16).padStart(2, '0');
    return `#${rr}${gg}${bb}`;
  }

  return null;
}

// ---------------------------------------------------------------------------
// XML escaping
// ---------------------------------------------------------------------------

/**
 * Escape special XML characters so that text content is safe to embed in SVG.
 *
 * @param text - Raw text string.
 * @returns The text with `&`, `<`, `>`, and `"` replaced by XML entities.
 */
function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Span grouping types
// ---------------------------------------------------------------------------

/** Style properties for a contiguous run of characters on a single row. */
interface CellStyle {
  fg: string | null;
  bg: string | null;
  bold: boolean;
  italic: boolean;
  dim: boolean;
  underline: boolean;
}

/** A contiguous run of characters sharing the same style. */
interface Span {
  text: string;
  style: CellStyle;
  startCol: number;
  colWidth: number;
}

// ---------------------------------------------------------------------------
// Main renderer
// ---------------------------------------------------------------------------

/**
 * Render an xterm Terminal buffer as a self-contained SVG string.
 *
 * The renderer walks every visible cell in the terminal's active buffer,
 * groups consecutive characters with identical styling into spans, and emits
 * background rectangles and text elements. The resulting SVG uses only inline
 * styles and embedded CSS classes, making it safe for GitHub markdown embedding.
 *
 * @param terminal - An xterm Terminal instance with `allowProposedApi` enabled.
 * @param options - Optional rendering configuration.
 * @returns A complete SVG document as a string.
 */
export function renderTerminalToSvg(terminal: Terminal, options?: SvgRenderOptions): string {
  const theme = options?.theme ?? DARK_THEME;
  const fontSize = options?.fontSize ?? 14;
  const fontFamily = options?.fontFamily ?? 'Menlo, Monaco, Courier New, monospace';
  const showCursor = options?.showCursor ?? true;
  const showWindowChrome = options?.showWindowChrome ?? true;
  const title = options?.title ?? '';
  const padding = options?.padding ?? 10;
  const borderRadius = options?.borderRadius ?? 8;

  // Monospace character metrics (approximate for common monospace fonts)
  const charWidth = fontSize * 0.6;
  const lineHeight = Math.ceil(fontSize * 1.3);
  const textBaseline = Math.ceil(fontSize * 1.0);

  const buffer = terminal.buffer.active;
  const cols = terminal.cols;
  const rows = terminal.rows;
  const startRow = buffer.baseY;

  // Chrome dimensions
  const chromeHeight = showWindowChrome ? 30 : 0;

  // Total SVG dimensions
  const contentWidth = cols * charWidth;
  const contentHeight = rows * lineHeight;
  const totalWidth = contentWidth + padding * 2;
  const totalHeight = contentHeight + padding * 2 + chromeHeight;

  // Cursor position
  const cursorX = buffer.cursorX;
  const cursorY = buffer.cursorY;

  // -----------------------------------------------------------------------
  // Pass 1: Walk the buffer and group cells into styled spans
  // -----------------------------------------------------------------------

  const rowSpans: Span[][] = [];
  const reusableCell = buffer.getNullCell();

  for (let row = 0; row < rows; row++) {
    const lineIndex = startRow + row;
    const line = buffer.getLine(lineIndex);
    const spans: Span[] = [];

    if (!line) {
      rowSpans.push(spans);
      continue;
    }

    let currentSpan: Span | null = null;

    for (let col = 0; col < cols; col++) {
      const cell = line.getCell(col, reusableCell);
      if (!cell) continue;

      const width = cell.getWidth();

      // Skip trailing half of wide characters (width === 0)
      if (width === 0) continue;

      const chars = cell.getChars() || ' ';
      const fg = resolveColor(cell, 'fg', theme);
      const bg = resolveColor(cell, 'bg', theme);
      const bold = cell.isBold() !== 0;
      const italic = cell.isItalic() !== 0;
      const dim = cell.isDim() !== 0;
      const underline = cell.isUnderline() !== 0;

      const style: CellStyle = { fg, bg, bold, italic, dim, underline };

      // Check if this cell continues the current span
      if (
        currentSpan?.style.fg === style.fg &&
        currentSpan.style.bg === style.bg &&
        currentSpan.style.bold === style.bold &&
        currentSpan.style.italic === style.italic &&
        currentSpan.style.dim === style.dim &&
        currentSpan.style.underline === style.underline
      ) {
        currentSpan.text += chars;
        currentSpan.colWidth += width;
      } else {
        if (currentSpan) {
          spans.push(currentSpan);
        }
        currentSpan = {
          text: chars,
          style,
          startCol: col,
          colWidth: width,
        };
      }
    }

    if (currentSpan) {
      spans.push(currentSpan);
    }

    rowSpans.push(spans);
  }

  // -----------------------------------------------------------------------
  // Pass 2: Emit SVG
  // -----------------------------------------------------------------------

  const svgParts: string[] = [];

  // SVG header
  svgParts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="${totalHeight}" viewBox="0 0 ${totalWidth} ${totalHeight}">`
  );

  // Embedded styles
  svgParts.push('<style>');
  svgParts.push(
    `.bg { fill: ${theme.background}; }`,
    `.fg { fill: ${theme.foreground}; font-family: ${fontFamily}; font-size: ${fontSize}px; white-space: pre; }`,
    '.b { font-weight: bold; }',
    '.i { font-style: italic; }',
    '.d { opacity: 0.5; }',
    '.u { text-decoration: underline; }'
  );
  svgParts.push('</style>');

  // Background rectangle
  svgParts.push(`<rect class="bg" width="100%" height="100%" rx="${borderRadius}"/>`);

  // Window chrome
  if (showWindowChrome) {
    // Three macOS-style dots
    svgParts.push(`<circle cx="${padding + 10}" cy="15" r="6" fill="#ff5f56"/>`);
    svgParts.push(`<circle cx="${padding + 28}" cy="15" r="6" fill="#ffbd2e"/>`);
    svgParts.push(`<circle cx="${padding + 46}" cy="15" r="6" fill="#27c93f"/>`);

    // Title text
    if (title) {
      svgParts.push(
        `<text x="50%" y="19" text-anchor="middle" class="fg" font-size="${fontSize - 1}px">${escapeXml(title)}</text>`
      );
    }

    // Separator line between chrome and content
    svgParts.push(
      `<line x1="0" y1="${chromeHeight}" x2="${totalWidth}" y2="${chromeHeight}" stroke="${theme.foreground}" stroke-opacity="0.15"/>`
    );
  }

  // Terminal content group
  svgParts.push(`<g transform="translate(${padding}, ${chromeHeight + padding})">`);

  for (let row = 0; row < rowSpans.length; row++) {
    const spans = rowSpans[row]!;
    const y = row * lineHeight;

    // Emit background rectangles for spans with non-default backgrounds
    for (const span of spans) {
      if (span.style.bg !== null) {
        const x = span.startCol * charWidth;
        const w = span.colWidth * charWidth;
        svgParts.push(`<rect x="${x}" y="${y}" width="${w}" height="${lineHeight}" fill="${span.style.bg}"/>`);
      }
    }

    // Emit text spans — skip rows that are entirely spaces with default style
    const hasVisibleText = spans.some(s => s.text.trim().length > 0 || s.style.fg !== null);
    if (!hasVisibleText) continue;

    const textY = y + textBaseline;
    const tspanParts: string[] = [];

    for (const span of spans) {
      const x = span.startCol * charWidth;
      const spanWidth = span.colWidth * charWidth;
      const attrs: string[] = [`x="${x}"`, `textLength="${spanWidth}"`, 'lengthAdjust="spacing"'];

      if (span.style.fg !== null) {
        attrs.push(`fill="${span.style.fg}"`);
      }

      // Build class list for text attributes
      const classes: string[] = [];
      if (span.style.bold) classes.push('b');
      if (span.style.italic) classes.push('i');
      if (span.style.dim) classes.push('d');
      if (span.style.underline) classes.push('u');
      if (classes.length > 0) {
        attrs.push(`class="${classes.join(' ')}"`);
      }

      tspanParts.push(`<tspan ${attrs.join(' ')}>${escapeXml(span.text)}</tspan>`);
    }

    // Concatenate tspans inline — newlines between tspans would render as
    // visible line breaks under white-space:pre / xml:space="preserve".
    svgParts.push(`<text y="${textY}" xml:space="preserve" class="fg">${tspanParts.join('')}</text>`);
  }

  svgParts.push('</g>');

  // Cursor overlay
  if (showCursor && cursorX < cols && cursorY < rows) {
    const cx = padding + cursorX * charWidth;
    const cy = chromeHeight + padding + cursorY * lineHeight;
    svgParts.push(
      `<rect x="${cx}" y="${cy}" width="${charWidth}" height="${lineHeight}" fill="${theme.cursor}" opacity="0.7"/>`
    );
  }

  // Close SVG
  svgParts.push('</svg>');

  return svgParts.join('\n');
}
