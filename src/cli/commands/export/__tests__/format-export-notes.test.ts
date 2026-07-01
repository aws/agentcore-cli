import { serializeResult } from '../../../../lib/result';
import type { ExportNote } from '../types';
import { formatExportNotes } from '../types';
import { describe, expect, it } from 'vitest';

const HINT = 'app/MyAgent/EXPORT_NOTES.md';

/** The export-harness success result the CLI `--json` branch serializes. `success: true as const` +
 *  the index signature satisfy serializeResult's `{ success: true } & Record<string, unknown>`. */
function makeExportSuccess(notes: ExportNote[]): {
  success: true;
  agentName: string;
  agentPath: string;
  notesPath: string;
  notes: ExportNote[];
  [k: string]: unknown;
} {
  return { success: true, agentName: 'MyAgent', agentPath: '/tmp/app/MyAgent', notesPath: HINT, notes };
}

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

// The CLI `--json` branch emits `JSON.stringify(serializeResult(result))`, so the export success
// result's `notes` array is a public contract for scripted consumers. Assert it survives that path
// as structured { category, message } objects.
describe('export --json notes contract', () => {
  const notes: ExportNote[] = [
    { category: 'Browser tool requires Container build', message: 'Re-export with --build Container.' },
    { category: 'Path skill not found locally', message: 'Ensure /opt/skills/x exists in the image.' },
  ];

  it('serializeResult preserves the notes array (with category + message)', () => {
    const serialized = serializeResult(makeExportSuccess(notes)) as { notes: ExportNote[] };
    expect(serialized.notes).toEqual(notes);
  });

  it('notes survive a JSON round-trip as structured objects (the emitted --json payload)', () => {
    const emitted = JSON.parse(JSON.stringify(serializeResult(makeExportSuccess(notes)))) as {
      success: boolean;
      notes: ExportNote[];
    };
    expect(emitted.success).toBe(true);
    expect(Array.isArray(emitted.notes)).toBe(true);
    expect(emitted.notes).toHaveLength(2);
    expect(emitted.notes[0]).toEqual({
      category: 'Browser tool requires Container build',
      message: 'Re-export with --build Container.',
    });
  });

  it('emits an empty notes array (not undefined) when there are no notes', () => {
    const emitted = JSON.parse(JSON.stringify(serializeResult(makeExportSuccess([])))) as { notes: ExportNote[] };
    expect(emitted.notes).toEqual([]);
  });
});
