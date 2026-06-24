import { COMPONENT_KEY_PATTERN } from '../constants';
import { useAddConfigBundleWizard } from '../useAddConfigBundleWizard';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import React, { act, useImperativeHandle } from 'react';
import { describe, expect, it } from 'vitest';

type WizardReturn = ReturnType<typeof useAddConfigBundleWizard>;

interface HarnessHandle {
  wizard: WizardReturn;
}

const Harness = React.forwardRef<HarnessHandle>((_props, ref) => {
  const wizard = useAddConfigBundleWizard();
  useImperativeHandle(ref, () => ({ wizard }));
  return <Text>step:{wizard.step}</Text>;
});
Harness.displayName = 'Harness';

function setup() {
  const ref = React.createRef<HarnessHandle>();
  const result = render(<Harness ref={ref} />);
  return { ref, ...result };
}

/** Drive the wizard forward to the addAnother step with one component configured. */
function advanceToAddAnother(ref: React.RefObject<HarnessHandle | null>) {
  act(() => ref.current!.wizard.setName('myBundle'));
  act(() => ref.current!.wizard.setDescription('desc'));
  act(() => ref.current!.wizard.setComponentType('runtime'));
  act(() => ref.current!.wizard.setSelectedComponent('arn:aws:runtime/r1'));
  act(() => ref.current!.wizard.setConfiguration({ systemPrompt: 'hi' }));
}

describe('useAddConfigBundleWizard — add-another back-navigation (BUG TUI-B)', () => {
  it('reaches addAnother after configuring one component', () => {
    const { ref } = setup();
    advanceToAddAnother(ref);
    expect(ref.current!.wizard.step).toBe('addAnother');
  });

  it('back from a re-entered componentType returns to addAnother, not description', () => {
    const { ref } = setup();
    advanceToAddAnother(ref);

    // User chooses "add another component" → re-enters componentType.
    act(() => ref.current!.wizard.addAnotherComponent());
    expect(ref.current!.wizard.step).toBe('componentType');

    // Backing out must return to the addAnother decision point (where "Continue" lives),
    // NOT fall through the linear order to `description` (which would strip the Continue path).
    act(() => ref.current!.wizard.goBack());
    expect(ref.current!.wizard.step).toBe('addAnother');

    // And the already-configured component is preserved.
    expect(Object.keys(ref.current!.wizard.config.components)).toHaveLength(1);
  });

  it('back from re-entered componentSelect returns to componentType, then to addAnother', () => {
    const { ref } = setup();
    advanceToAddAnother(ref);
    act(() => ref.current!.wizard.addAnotherComponent());
    act(() => ref.current!.wizard.setComponentType('runtime'));
    expect(ref.current!.wizard.step).toBe('componentSelect');

    act(() => ref.current!.wizard.goBack());
    expect(ref.current!.wizard.step).toBe('componentType');
    act(() => ref.current!.wizard.goBack());
    expect(ref.current!.wizard.step).toBe('addAnother');
  });

  it('doneAddingComponents advances past components and clears the loop flag', () => {
    const { ref } = setup();
    advanceToAddAnother(ref);
    act(() => ref.current!.wizard.doneAddingComponents());
    expect(ref.current!.wizard.step).toBe('branchName');

    // Back from the current step follows the linear order, not the loop guard.
    act(() => ref.current!.wizard.goBack());
    expect(ref.current!.wizard.step).toBe('addAnother');
  });

  it('first-pass back-navigation is unaffected (componentType → description)', () => {
    const { ref } = setup();
    act(() => ref.current!.wizard.setName('myBundle'));
    act(() => ref.current!.wizard.setDescription('desc'));
    expect(ref.current!.wizard.step).toBe('componentType');
    act(() => ref.current!.wizard.goBack());
    expect(ref.current!.wizard.step).toBe('description');
  });
});

describe('useAddConfigBundleWizard — custom ARN component (Part 1)', () => {
  /** Drive the wizard to the componentType step. */
  function advanceToComponentType(ref: React.RefObject<HarnessHandle | null>) {
    act(() => ref.current!.wizard.setName('myBundle'));
    act(() => ref.current!.wizard.setDescription('desc'));
  }

  const CUSTOM_ARN = 'arn:aws:bedrock-agentcore:us-west-2:123456789012:gateway-target/orders-Tg9xK2';

  it('selecting custom routes componentType → componentArnEntry (not componentSelect)', () => {
    const { ref } = setup();
    advanceToComponentType(ref);
    act(() => ref.current!.wizard.setComponentType('custom'));
    expect(ref.current!.wizard.step).toBe('componentArnEntry');
    expect(ref.current!.wizard.config.currentComponentType).toBe('custom');
  });

  it('a pattern-valid ARN advances to configuration and is stored verbatim as currentComponentArn', () => {
    const { ref } = setup();
    advanceToComponentType(ref);
    act(() => ref.current!.wizard.setComponentType('custom'));
    act(() => ref.current!.wizard.setCustomArn(CUSTOM_ARN));
    expect(ref.current!.wizard.step).toBe('configuration');
    expect(ref.current!.wizard.config.currentComponentArn).toBe(CUSTOM_ARN);
  });

  it('the custom component lands in config.components under the literal ARN key', () => {
    const { ref } = setup();
    advanceToComponentType(ref);
    act(() => ref.current!.wizard.setComponentType('custom'));
    act(() => ref.current!.wizard.setCustomArn(CUSTOM_ARN));
    act(() => ref.current!.wizard.setConfiguration({ systemPrompt: 'hi' }));
    expect(ref.current!.wizard.step).toBe('addAnother');
    expect(Object.keys(ref.current!.wizard.config.components)).toContain(CUSTOM_ARN);
    expect(ref.current!.wizard.config.components[CUSTOM_ARN]).toEqual({
      configuration: { systemPrompt: 'hi' },
    });
  });

  it('goBack from componentArnEntry returns to componentType', () => {
    const { ref } = setup();
    advanceToComponentType(ref);
    act(() => ref.current!.wizard.setComponentType('custom'));
    expect(ref.current!.wizard.step).toBe('componentArnEntry');
    act(() => ref.current!.wizard.goBack());
    expect(ref.current!.wizard.step).toBe('componentType');
  });

  it('runtime/gateway types still route to componentSelect (regression)', () => {
    const { ref } = setup();
    advanceToComponentType(ref);
    act(() => ref.current!.wizard.setComponentType('runtime'));
    expect(ref.current!.wizard.step).toBe('componentSelect');

    act(() => ref.current!.wizard.goBack());
    expect(ref.current!.wizard.step).toBe('componentType');
    act(() => ref.current!.wizard.setComponentType('gateway'));
    expect(ref.current!.wizard.step).toBe('componentSelect');
  });

  it('COMPONENT_KEY_PATTERN accepts ARNs and non-ARN identifiers, rejects placeholders/spaces/over-length', () => {
    // Accept any pattern-valid string — an arn: prefix is NOT required (DECIDED).
    expect(COMPONENT_KEY_PATTERN.test(CUSTOM_ARN)).toBe(true);
    expect(COMPONENT_KEY_PATTERN.test('myComponentKey')).toBe(true);
    // Reject placeholders, spaces, and over-length (>2048 chars).
    expect(COMPONENT_KEY_PATTERN.test('{{runtime:MyAgent}}')).toBe(false);
    expect(COMPONENT_KEY_PATTERN.test('not a valid arn!!')).toBe(false);
    expect(COMPONENT_KEY_PATTERN.test('a'.repeat(2049))).toBe(false);
    expect(COMPONENT_KEY_PATTERN.test('a'.repeat(2048))).toBe(true);
  });
});
