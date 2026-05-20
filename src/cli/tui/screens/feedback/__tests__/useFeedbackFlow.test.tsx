import { useFeedbackFlow } from '../useFeedbackFlow';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import React, { act, useImperativeHandle } from 'react';
import { describe, expect, it, vi } from 'vitest';

type FlowReturn = ReturnType<typeof useFeedbackFlow>;

interface HarnessHandle {
  flow: FlowReturn;
}

interface HarnessProps {
  onSubmit: NonNullable<Parameters<typeof useFeedbackFlow>[0]>['onSubmit'];
  initialScreenshot?: string;
}

const Harness = React.forwardRef<HarnessHandle, HarnessProps>((props, ref) => {
  const flow = useFeedbackFlow({ onSubmit: props.onSubmit, initialScreenshot: props.initialScreenshot });
  useImperativeHandle(ref, () => ({ flow }));
  return (
    <Text>
      phase:{flow.state.phase} message:{flow.state.message || '<empty>'} screenshot:
      {flow.state.screenshotPath ?? '<none>'} error:
      {flow.state.error ?? '<none>'}
    </Text>
  );
});
Harness.displayName = 'Harness';

function setup(onSubmit: HarnessProps['onSubmit'], initialScreenshot?: string) {
  const ref = React.createRef<HarnessHandle>();
  const result = render(<Harness ref={ref} onSubmit={onSubmit} initialScreenshot={initialScreenshot} />);
  return { ref, ...result };
}

async function flushAsync() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const successResult = { id: 'sub-1', timestamp: '2026-05-13T18:00:00Z', reference: 'S3' };

describe('useFeedbackFlow', () => {
  it('starts on the message phase', () => {
    const { ref } = setup(vi.fn());
    expect(ref.current!.flow.state.phase).toBe('message');
  });

  it('walks through message → screenshot prompt → screenshot path → consent → success', async () => {
    const onSubmit = vi.fn().mockResolvedValue(successResult);
    const { ref } = setup(onSubmit);

    act(() => ref.current!.flow.setMessage('hello'));
    expect(ref.current!.flow.state.phase).toBe('screenshot-prompt');

    act(() => ref.current!.flow.chooseAttachScreenshot());
    expect(ref.current!.flow.state.phase).toBe('screenshot-path');

    act(() => ref.current!.flow.setScreenshot('/tmp/shot.png'));
    expect(ref.current!.flow.state.phase).toBe('consent');
    expect(ref.current!.flow.state.screenshotPath).toBe('/tmp/shot.png');

    act(() => ref.current!.flow.confirmConsent());
    await flushAsync();

    expect(onSubmit).toHaveBeenCalledWith({
      message: 'hello',
      screenshot: { path: '/tmp/shot.png' },
      mode: 'tui',
    });
    expect(ref.current!.flow.state.phase).toBe('success');
    expect(ref.current!.flow.state.result).toEqual(successResult);
  });

  it('skips screenshot via the prompt step', () => {
    const { ref } = setup(vi.fn());
    act(() => ref.current!.flow.setMessage('hi'));
    expect(ref.current!.flow.state.phase).toBe('screenshot-prompt');

    act(() => ref.current!.flow.skipScreenshot());
    expect(ref.current!.flow.state.phase).toBe('consent');
    expect(ref.current!.flow.state.screenshotPath).toBeUndefined();
  });

  it('treats an empty screenshot path the same as skipping', () => {
    const { ref } = setup(vi.fn());
    act(() => ref.current!.flow.setMessage('hi'));
    act(() => ref.current!.flow.chooseAttachScreenshot());
    act(() => ref.current!.flow.setScreenshot(undefined));
    expect(ref.current!.flow.state.phase).toBe('consent');
    expect(ref.current!.flow.state.screenshotPath).toBeUndefined();
  });

  it('returns to the message phase with the message preserved when consent is declined', () => {
    const { ref } = setup(vi.fn());
    act(() => ref.current!.flow.setMessage('I want to keep this'));
    act(() => ref.current!.flow.skipScreenshot());
    act(() => ref.current!.flow.declineConsent());
    expect(ref.current!.flow.state.phase).toBe('message');
    expect(ref.current!.flow.state.message).toBe('I want to keep this');
  });

  it('moves to error phase when submission fails and supports retry', async () => {
    const onSubmit = vi.fn().mockRejectedValueOnce(new Error('HTTP 500')).mockResolvedValueOnce(successResult);

    const { ref } = setup(onSubmit);
    act(() => ref.current!.flow.setMessage('boom'));
    act(() => ref.current!.flow.skipScreenshot());
    act(() => ref.current!.flow.confirmConsent());
    await flushAsync();
    expect(ref.current!.flow.state.phase).toBe('error');
    expect(ref.current!.flow.state.error).toBe('HTTP 500');

    act(() => ref.current!.flow.retry());
    await flushAsync();
    expect(ref.current!.flow.state.phase).toBe('success');
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  it('goBack() steps from screenshot-prompt → message and from consent → screenshot-prompt', () => {
    const { ref } = setup(vi.fn());
    act(() => ref.current!.flow.setMessage('hi'));
    expect(ref.current!.flow.state.phase).toBe('screenshot-prompt');
    act(() => ref.current!.flow.goBack());
    expect(ref.current!.flow.state.phase).toBe('message');

    act(() => ref.current!.flow.setMessage('hi again'));
    act(() => ref.current!.flow.skipScreenshot());
    expect(ref.current!.flow.state.phase).toBe('consent');
    act(() => ref.current!.flow.goBack());
    expect(ref.current!.flow.state.phase).toBe('screenshot-prompt');
  });

  it('goBack() steps from screenshot-path → screenshot-prompt', () => {
    const { ref } = setup(vi.fn());
    act(() => ref.current!.flow.setMessage('hi'));
    act(() => ref.current!.flow.chooseAttachScreenshot());
    expect(ref.current!.flow.state.phase).toBe('screenshot-path');
    act(() => ref.current!.flow.goBack());
    expect(ref.current!.flow.state.phase).toBe('screenshot-prompt');
  });
});
