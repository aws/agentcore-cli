import type { ExportNote } from '../types';
import { formatExportNotes } from '../types';
import { describe, expect, it } from 'vitest';

const HINT = 'app/MyAgent/EXPORT_NOTES.md';

describe('formatExportNotes', () => {
  it('returns a single dim "no follow-up" line when there are no notes', () => {
    const lines = formatExportNotes([], HINT);
    expect(lines).toEqual([{ text: `No manual follow-up required. (Details: ${HINT})`, tone: 'dim' }]);
  });

  it('renders a warning header (singular) + category + message + file hint for one note', () => {
    const notes: ExportNote[] = [
      { category: 'Browser tool requires Container build', message: 'Re-export with --build Container.' },
    ];
    const lines = formatExportNotes(notes, HINT);

    // Header is a single "note" (not "notes") and carries the warn tone.
    expect(lines[0]).toEqual({ text: '⚠ 1 export note requiring manual follow-up:', tone: 'warn' });
    // Category is warn-toned and bulleted.
    expect(lines).toContainEqual({ text: '  • Browser tool requires Container build', tone: 'warn' });
    // Message line is dim and indented.
    expect(lines).toContainEqual({ text: '    Re-export with --build Container.', tone: 'dim' });
    // Trailing pointer to the on-disk copy.
    expect(lines.at(-1)).toEqual({ text: `These notes are also saved to ${HINT}`, tone: 'dim' });
  });

  it('pluralizes the header and lists every note when there are multiple', () => {
    const notes: ExportNote[] = [
      { category: 'First', message: 'a' },
      { category: 'Second', message: 'b' },
    ];
    const lines = formatExportNotes(notes, HINT);
    expect(lines[0]?.text).toBe('⚠ 2 export notes requiring manual follow-up:');
    expect(lines).toContainEqual({ text: '  • First', tone: 'warn' });
    expect(lines).toContainEqual({ text: '  • Second', tone: 'warn' });
  });

  it('splits a multi-line message into one dim line per line (preserving order)', () => {
    const notes: ExportNote[] = [{ category: 'C', message: 'line one\nline two\nline three' }];
    const lines = formatExportNotes(notes, HINT);
    const messageLines = lines.filter(l => l.tone === 'dim' && l.text.startsWith('    '));
    expect(messageLines.map(l => l.text)).toEqual(['    line one', '    line two', '    line three']);
  });
});
