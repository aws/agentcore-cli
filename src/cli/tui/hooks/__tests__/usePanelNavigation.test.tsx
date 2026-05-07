import { usePanelNavigation } from '../usePanelNavigation.js';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const UP_ARROW = '\x1B[A';
const DOWN_ARROW = '\x1B[B';
const ENTER = '\r';
const ESCAPE = '\x1B';
const TAB = '\t';

afterEach(() => vi.restoreAllMocks());

// Wrapper component to test the hook via rendering
function PanelNav({
  isActive = true,
  fieldCount = 3,
  onExit = vi.fn(),
  isFieldDisabled,
  isFieldAutoCompleted,
  onComplete,
  onResult,
}: {
  isActive?: boolean;
  fieldCount?: number;
  onExit?: () => void;
  isFieldDisabled?: (column: number, field: number) => boolean;
  isFieldAutoCompleted?: (column: number, field: number) => boolean;
  onComplete?: () => void;
  onResult?: (result: ReturnType<typeof usePanelNavigation>) => void;
}) {
  const result = usePanelNavigation({
    isActive,
    fieldCount,
    onExit,
    isFieldDisabled,
    isFieldAutoCompleted,
    onComplete,
  });

  onResult?.(result);

  return (
    <Text>
      col:{result.position.column} field:{result.position.field} layer:{result.position.layer}
    </Text>
  );
}

const delay = (ms = 50) => new Promise(resolve => setTimeout(resolve, ms));

describe('usePanelNavigation', () => {
  it('starts at column 0, field 0, layer focus', () => {
    const { lastFrame } = render(<PanelNav />);
    expect(lastFrame()).toContain('col:0');
    expect(lastFrame()).toContain('field:0');
    expect(lastFrame()).toContain('layer:focus');
  });

  describe('Tab switches columns', () => {
    it('Tab switches from column 0 to column 1', async () => {
      const { lastFrame, stdin } = render(<PanelNav />);

      await delay();
      stdin.write(TAB);
      await delay();

      expect(lastFrame()).toContain('col:1');
    });

    it('Tab switches from column 1 back to column 0', async () => {
      const { lastFrame, stdin } = render(<PanelNav />);

      await delay();
      stdin.write(TAB); // 0 → 1
      await delay();
      stdin.write(TAB); // 1 → 0
      await delay();

      expect(lastFrame()).toContain('col:0');
    });
  });

  describe('Up/Down moves between fields', () => {
    it('Down moves to next field', async () => {
      const { lastFrame, stdin } = render(<PanelNav />);

      await delay();
      stdin.write(DOWN_ARROW);
      await delay();

      expect(lastFrame()).toContain('field:1');
    });

    it('Up moves to previous field', async () => {
      const { lastFrame, stdin } = render(<PanelNav />);

      await delay();
      stdin.write(DOWN_ARROW);
      stdin.write(DOWN_ARROW);
      await delay();
      expect(lastFrame()).toContain('field:2');

      stdin.write(UP_ARROW);
      await delay();
      expect(lastFrame()).toContain('field:1');
    });
  });

  it('Up at field 0 stays at field 0', async () => {
    const { lastFrame, stdin } = render(<PanelNav />);

    await delay();
    stdin.write(UP_ARROW);
    await delay();

    expect(lastFrame()).toContain('field:0');
  });

  it('Down at last field stays at last field', async () => {
    const { lastFrame, stdin } = render(<PanelNav fieldCount={3} />);

    await delay();
    stdin.write(DOWN_ARROW);
    stdin.write(DOWN_ARROW); // field 2 (last)
    await delay();
    expect(lastFrame()).toContain('field:2');

    stdin.write(DOWN_ARROW); // should stay
    await delay();
    expect(lastFrame()).toContain('field:2');
  });

  it('Enter activates field (layer → active)', async () => {
    const { lastFrame, stdin } = render(<PanelNav />);

    await delay();
    stdin.write(ENTER);
    await delay();

    expect(lastFrame()).toContain('layer:active');
  });

  describe('Escape navigation', () => {
    it('Escape at field 0 column 0 calls onExit', async () => {
      const onExit = vi.fn();
      const { stdin } = render(<PanelNav onExit={onExit} />);

      await delay();
      stdin.write(ESCAPE);
      await delay();

      expect(onExit).toHaveBeenCalledTimes(1);
    });

    it('Escape at field > 0 goes to field 0', async () => {
      const { lastFrame, stdin } = render(<PanelNav />);

      await delay();
      stdin.write(DOWN_ARROW);
      stdin.write(DOWN_ARROW);
      await delay();
      expect(lastFrame()).toContain('field:2');

      stdin.write(ESCAPE);
      await delay();
      expect(lastFrame()).toContain('field:0');
    });

    it('Escape at column 1 field 0 goes to column 0', async () => {
      const { lastFrame, stdin } = render(<PanelNav />);

      await delay();
      stdin.write(TAB); // go to column 1
      await delay();
      expect(lastFrame()).toContain('col:1');

      stdin.write(ESCAPE);
      await delay();
      expect(lastFrame()).toContain('col:0');
      expect(lastFrame()).toContain('field:0');
    });
  });

  describe('deactivate auto-advance', () => {
    it('deactivate auto-advances to next field in same column', async () => {
      const onResult = vi.fn();
      const { stdin } = render(<PanelNav onResult={onResult} />);

      await delay();
      stdin.write(ENTER); // activate field 0
      await delay();

      const result = onResult.mock.calls[onResult.mock.calls.length - 1]![0];
      expect(result.position.layer).toBe('active');
    });
  });

  describe('deactivate behavior', () => {
    // Harness that auto-deactivates when activated to test the deactivate advance path
    function AutoDeactivateHarness({ fieldCount = 3, onComplete }: { fieldCount?: number; onComplete?: () => void }) {
      const nav = usePanelNavigation({
        isActive: true,
        fieldCount,
        onExit: vi.fn(),
        onComplete,
      });

      // When activated, immediately deactivate on next render
      React.useEffect(() => {
        if (nav.position.layer === 'active') {
          nav.deactivate();
        }
      }, [nav.position.layer, nav.position.column, nav.position.field, nav.deactivate]);

      return (
        <Text>
          col:{nav.position.column} field:{nav.position.field} layer:{nav.position.layer}
        </Text>
      );
    }

    it('deactivate at field 0 advances to field 1 in same column', async () => {
      const { lastFrame, stdin } = render(<AutoDeactivateHarness />);

      await delay();
      stdin.write(ENTER); // activate field 0 → auto-deactivate → field 1
      await delay();

      expect(lastFrame()).toContain('field:1');
      expect(lastFrame()).toContain('col:0');
      expect(lastFrame()).toContain('layer:focus');
    });

    it('deactivate at last field of column 0 moves to column 1 field 0', async () => {
      const { lastFrame, stdin } = render(<AutoDeactivateHarness fieldCount={1} />);

      await delay();
      stdin.write(ENTER); // activate field 0 (last in col 0) → auto-deactivate → col 1 field 0
      await delay();

      expect(lastFrame()).toContain('col:1');
      expect(lastFrame()).toContain('field:0');
    });

    it('deactivate at last field of column 1 calls onComplete', async () => {
      const onComplete = vi.fn();
      const { lastFrame, stdin } = render(<AutoDeactivateHarness fieldCount={1} onComplete={onComplete} />);

      await delay();
      // Move to column 1 first
      stdin.write(ENTER); // col 0 field 0 → deactivate → col 1 field 0
      await delay();

      expect(lastFrame()).toContain('col:1');
      expect(lastFrame()).toContain('field:0');

      stdin.write(ENTER); // col 1 field 0 (last) → deactivate → onComplete
      await delay(100);

      expect(onComplete).toHaveBeenCalled();
    });
  });

  describe('isFieldFocused/isFieldActive/isColumnActive', () => {
    it('isFieldFocused returns true for current position in focus layer', () => {
      let resultRef: ReturnType<typeof usePanelNavigation> | undefined;
      render(
        <PanelNav
          onResult={r => {
            resultRef = r;
          }}
        />
      );

      expect(resultRef!.isFieldFocused(0, 0)).toBe(true);
      expect(resultRef!.isFieldFocused(0, 1)).toBe(false);
      expect(resultRef!.isFieldFocused(1, 0)).toBe(false);
    });

    it('isFieldActive returns false in focus layer', () => {
      let resultRef: ReturnType<typeof usePanelNavigation> | undefined;
      render(
        <PanelNav
          onResult={r => {
            resultRef = r;
          }}
        />
      );

      expect(resultRef!.isFieldActive(0, 0)).toBe(false);
    });

    it('isColumnActive returns true for current column', () => {
      let resultRef: ReturnType<typeof usePanelNavigation> | undefined;
      render(
        <PanelNav
          onResult={r => {
            resultRef = r;
          }}
        />
      );

      expect(resultRef!.isColumnActive(0)).toBe(true);
      expect(resultRef!.isColumnActive(1)).toBe(false);
    });
  });

  describe('disabled fields are skipped', () => {
    it('Down skips disabled field', async () => {
      const isFieldDisabled = (_col: number, field: number) => field === 1;
      const { lastFrame, stdin } = render(<PanelNav isFieldDisabled={isFieldDisabled} />);

      await delay();
      stdin.write(DOWN_ARROW); // should skip field 1 and land on field 2
      await delay();

      expect(lastFrame()).toContain('field:2');
    });

    it('Up skips disabled field', async () => {
      const isFieldDisabled = (_col: number, field: number) => field === 1;
      const { lastFrame, stdin } = render(<PanelNav isFieldDisabled={isFieldDisabled} />);

      await delay();
      stdin.write(DOWN_ARROW); // skip 1 → field 2
      await delay();
      expect(lastFrame()).toContain('field:2');

      stdin.write(UP_ARROW); // skip 1 → field 0
      await delay();
      expect(lastFrame()).toContain('field:0');
    });

    it('stays in place when all remaining fields are disabled', async () => {
      const { lastFrame, stdin } = render(<PanelNav fieldCount={2} isFieldDisabled={(_c, f) => f === 1} />);

      await delay();
      // field 0, only field 1 exists and is disabled → stay at 0
      stdin.write(DOWN_ARROW);
      await delay();

      expect(lastFrame()).toContain('field:0');
    });
  });
});
