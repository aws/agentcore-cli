import { TelemetryClient } from '../../../../telemetry/client';
import { TelemetryClientAccessor } from '../../../../telemetry/client-accessor';
import { InMemorySink } from '../../../../telemetry/sinks/in-memory-sink';
import { useFeedbackFlow } from '../useFeedbackFlow';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import React, { act, useImperativeHandle } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let sink: InMemorySink;

beforeEach(() => {
  sink = new InMemorySink();
  vi.spyOn(TelemetryClientAccessor, 'get').mockResolvedValue(new TelemetryClient(sink));
});

afterEach(() => {
  vi.restoreAllMocks();
});

type FlowReturn = ReturnType<typeof useFeedbackFlow>;

interface HarnessHandle {
  flow: FlowReturn;
}

interface HarnessProps {
  onSubmit: NonNullable<Parameters<typeof useFeedbackFlow>[0]>['onSubmit'];
  initialScreenshot?: string;
  validateMessage?: NonNullable<Parameters<typeof useFeedbackFlow>[0]>['validateMessage'];
  validateScreenshot?: NonNullable<Parameters<typeof useFeedbackFlow>[0]>['validateScreenshot'];
}

const Harness = React.forwardRef<HarnessHandle, HarnessProps>((props, ref) => {
  const flow = useFeedbackFlow({
    onSubmit: props.onSubmit,
    initialScreenshot: props.initialScreenshot,
    validateMessage: props.validateMessage,
    validateScreenshot: props.validateScreenshot,
  });
  useImperativeHandle(ref, () => ({ flow }));
  return (
    <Text>
      phase:{flow.state.phase} message:{flow.state.message || '<empty>'} screenshot:
      {flow.state.screenshotPath ?? '<none>'} error:
      {flow.state.error?.message ?? '<none>'} inputError:{flow.state.inputError ?? '<none>'}
    </Text>
  );
});
Harness.displayName = 'Harness';

function setup(props: HarnessProps) {
  const ref = React.createRef<HarnessHandle>();
  const result = render(<Harness ref={ref} {...props} />);
  return { ref, ...result };
}

async function flushAsync() {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
}

const successResult = { id: 'sub-1', timestamp: '2026-05-13T18:00:00Z', reference: 'S3' };
const stubValidateMessage = () => null;
const stubValidateScreenshot = () => Promise.resolve(null);

describe('useFeedbackFlow', () => {
  it('starts on the message phase', () => {
    const { ref } = setup({ onSubmit: vi.fn(), validateMessage: stubValidateMessage });
    expect(ref.current!.flow.state.phase).toBe('message');
  });

  it('walks through message → screenshot prompt → screenshot path → consent → success', async () => {
    const onSubmit = vi.fn().mockResolvedValue(successResult);
    const { ref } = setup({
      onSubmit,
      validateMessage: stubValidateMessage,
      validateScreenshot: stubValidateScreenshot,
    });

    act(() => ref.current!.flow.setMessage('hello'));
    expect(ref.current!.flow.state.phase).toBe('screenshot');

    await act(async () => {
      await ref.current!.flow.setScreenshot('/tmp/shot.png');
    });
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

    expect(sink.metrics).toHaveLength(1);
    expect(sink.metrics[0]!.attrs).toMatchObject({
      command: 'feedback',
      exit_reason: 'success',
      mode: 'tui',
      has_screenshot: 'true',
    });
  });

  it('keeps the user on the message phase and shows inputError when message is invalid', () => {
    const validateMessage = vi.fn(() => 'too short');
    const { ref } = setup({ onSubmit: vi.fn(), validateMessage });
    act(() => ref.current!.flow.setMessage(''));
    expect(ref.current!.flow.state.phase).toBe('message');
    expect(ref.current!.flow.state.inputError).toBe('too short');
  });

  it('keeps the user on the screenshot phase and shows inputError for invalid screenshots', async () => {
    const validateScreenshot = vi.fn(() => Promise.resolve('not a png' as string | null));
    const { ref } = setup({
      onSubmit: vi.fn(),
      validateMessage: stubValidateMessage,
      validateScreenshot,
    });
    act(() => ref.current!.flow.setMessage('hi'));
    await act(async () => {
      await ref.current!.flow.setScreenshot('/tmp/foo.gif');
    });
    expect(ref.current!.flow.state.phase).toBe('screenshot');
    expect(ref.current!.flow.state.inputError).toBe('not a png');
    expect(ref.current!.flow.state.screenshotPath).toBe('/tmp/foo.gif');
  });

  it('skips the screenshot via Esc (skipScreenshot)', () => {
    const { ref } = setup({ onSubmit: vi.fn(), validateMessage: stubValidateMessage });
    act(() => ref.current!.flow.setMessage('hi'));
    expect(ref.current!.flow.state.phase).toBe('screenshot');

    act(() => ref.current!.flow.skipScreenshot());
    expect(ref.current!.flow.state.phase).toBe('consent');
    expect(ref.current!.flow.state.screenshotPath).toBeUndefined();
  });

  it('treats an empty screenshot path the same as skipping', async () => {
    const { ref } = setup({
      onSubmit: vi.fn(),
      validateMessage: stubValidateMessage,
      validateScreenshot: stubValidateScreenshot,
    });
    act(() => ref.current!.flow.setMessage('hi'));
    await act(async () => {
      await ref.current!.flow.setScreenshot(undefined);
    });
    expect(ref.current!.flow.state.phase).toBe('consent');
    expect(ref.current!.flow.state.screenshotPath).toBeUndefined();
  });

  it('returns to the message phase with the message preserved when consent is declined', () => {
    const { ref } = setup({ onSubmit: vi.fn(), validateMessage: stubValidateMessage });
    act(() => ref.current!.flow.setMessage('I want to keep this'));
    act(() => ref.current!.flow.skipScreenshot());
    act(() => ref.current!.flow.declineConsent());
    expect(ref.current!.flow.state.phase).toBe('message');
    expect(ref.current!.flow.state.message).toBe('I want to keep this');
  });

  it('moves to error phase when submission fails and supports retry', async () => {
    const onSubmit = vi.fn().mockRejectedValueOnce(new Error('HTTP 500')).mockResolvedValueOnce(successResult);
    const { ref } = setup({ onSubmit, validateMessage: stubValidateMessage });
    act(() => ref.current!.flow.setMessage('boom'));
    act(() => ref.current!.flow.skipScreenshot());
    act(() => ref.current!.flow.confirmConsent());
    await flushAsync();
    expect(ref.current!.flow.state.phase).toBe('error');
    expect(ref.current!.flow.state.error?.message).toBe('HTTP 500');

    act(() => ref.current!.flow.retry());
    await flushAsync();
    expect(ref.current!.flow.state.phase).toBe('success');
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  it('goBack() steps from screenshot → message and from consent → screenshot', () => {
    const { ref } = setup({ onSubmit: vi.fn(), validateMessage: stubValidateMessage });
    act(() => ref.current!.flow.setMessage('hi'));
    expect(ref.current!.flow.state.phase).toBe('screenshot');
    act(() => ref.current!.flow.goBack());
    expect(ref.current!.flow.state.phase).toBe('message');

    act(() => ref.current!.flow.setMessage('hi again'));
    act(() => ref.current!.flow.skipScreenshot());
    expect(ref.current!.flow.state.phase).toBe('consent');
    act(() => ref.current!.flow.goBack());
    expect(ref.current!.flow.state.phase).toBe('screenshot');
  });
});
