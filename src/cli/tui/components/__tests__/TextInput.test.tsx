import { TextInput } from '../TextInput.js';
import { render } from 'ink-testing-library';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const ENTER = '\r';
const ESCAPE = '\x1B';

function delay(ms = 50) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

afterEach(() => vi.restoreAllMocks());

describe('TextInput', () => {
  it('renders prompt text', () => {
    const { lastFrame } = render(<TextInput prompt="Enter name:" onSubmit={vi.fn()} onCancel={vi.fn()} />);

    expect(lastFrame()).toContain('Enter name:');
  });

  it('renders placeholder when value is empty', () => {
    const { lastFrame } = render(
      <TextInput prompt="Name" placeholder="my-agent" onSubmit={vi.fn()} onCancel={vi.fn()} />
    );

    // Placeholder shows all chars after cursor position (slice(1))
    expect(lastFrame()).toContain('y-agent');
  });

  it('renders initial value', () => {
    const { lastFrame } = render(
      <TextInput prompt="Name" initialValue="hello" onSubmit={vi.fn()} onCancel={vi.fn()} />
    );

    expect(lastFrame()).toContain('hello');
  });

  it('shows > arrow by default', () => {
    const { lastFrame } = render(<TextInput prompt="Name" onSubmit={vi.fn()} onCancel={vi.fn()} />);

    expect(lastFrame()).toContain('>');
  });

  it('hides arrow when hideArrow is true', () => {
    const { lastFrame } = render(<TextInput prompt="Name" hideArrow onSubmit={vi.fn()} onCancel={vi.fn()} />);
    const lines = lastFrame()!.split('\n');
    // The input line should not start with >
    const inputLine = lines.find(l => !l.includes('Name'))!;
    expect(inputLine).not.toMatch(/>\s/);
  });

  it('accepts character input and displays it', async () => {
    const { lastFrame, stdin } = render(<TextInput prompt="Name" onSubmit={vi.fn()} onCancel={vi.fn()} />);

    await delay();
    stdin.write('a');
    stdin.write('b');
    stdin.write('c');
    await delay();

    expect(lastFrame()).toContain('abc');
  });

  it('calls onSubmit with trimmed value on Enter', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(
      <TextInput prompt="Name" initialValue="  hello  " onSubmit={onSubmit} onCancel={vi.fn()} />
    );

    await delay();
    stdin.write(ENTER);
    await delay();

    expect(onSubmit).toHaveBeenCalledWith('hello');
  });

  it('does not call onSubmit when value is empty and allowEmpty is false', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<TextInput prompt="Name" onSubmit={onSubmit} onCancel={vi.fn()} />);

    await delay();
    stdin.write(ENTER);
    await delay();

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('calls onSubmit with empty value when allowEmpty is true', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<TextInput prompt="Name" allowEmpty onSubmit={onSubmit} onCancel={vi.fn()} />);

    await delay();
    stdin.write(ENTER);
    await delay();

    // allowEmpty + no validation error => submit
    expect(onSubmit).toHaveBeenCalledWith('');
  });

  it('calls onCancel on Escape', async () => {
    const onCancel = vi.fn();
    const { stdin } = render(<TextInput prompt="Name" onSubmit={vi.fn()} onCancel={onCancel} />);

    await delay();
    stdin.write(ESCAPE);
    await delay();

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('masks input when mask character is provided', async () => {
    const { lastFrame, stdin } = render(<TextInput prompt="Password" mask="*" onSubmit={vi.fn()} onCancel={vi.fn()} />);

    await delay();
    stdin.write('abc');
    await delay();

    const frame = lastFrame()!;
    expect(frame).toContain('***');
    expect(frame).not.toContain('abc');
  });

  it('shows checkmark when valid input with schema', async () => {
    const schema = z.string().min(3);
    const { lastFrame, stdin } = render(
      <TextInput prompt="Name" schema={schema} onSubmit={vi.fn()} onCancel={vi.fn()} />
    );

    await delay();
    stdin.write('hello');
    await delay();

    expect(lastFrame()).toContain('\u2713'); // checkmark
  });

  it('shows invalid mark when input fails schema validation', async () => {
    const schema = z.string().min(5);
    const { lastFrame, stdin } = render(
      <TextInput prompt="Name" schema={schema} onSubmit={vi.fn()} onCancel={vi.fn()} />
    );

    await delay();
    stdin.write('hi');
    await delay();

    expect(lastFrame()).toContain('\u2717'); // cross mark
  });

  it('does not submit when schema validation fails', async () => {
    const onSubmit = vi.fn();
    const schema = z.string().min(5);
    const { stdin } = render(<TextInput prompt="Name" schema={schema} onSubmit={onSubmit} onCancel={vi.fn()} />);

    await delay();
    stdin.write('hi');
    await delay();
    stdin.write(ENTER);
    await delay();

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('shows validation error message after submit attempt with invalid input', async () => {
    const schema = z.string().min(5, 'Must be at least 5 characters');
    const { lastFrame, stdin } = render(
      <TextInput prompt="Name" schema={schema} onSubmit={vi.fn()} onCancel={vi.fn()} />
    );

    await delay();
    stdin.write('hi');
    await delay();
    stdin.write(ENTER);
    await delay();

    expect(lastFrame()).toContain('Must be at least 5 characters');
  });

  it('supports custom validation', async () => {
    const customValidation = (val: string) => (val.startsWith('a') ? true : 'Must start with a');
    const { lastFrame, stdin } = render(
      <TextInput prompt="Name" customValidation={customValidation} onSubmit={vi.fn()} onCancel={vi.fn()} />
    );

    await delay();
    stdin.write('bbb');
    await delay();

    expect(lastFrame()).toContain('\u2717'); // cross mark
  });

  it('does not submit when custom validation fails', async () => {
    const onSubmit = vi.fn();
    const customValidation = (val: string) => (val.startsWith('a') ? true : 'Must start with a');
    const { stdin } = render(
      <TextInput prompt="Name" customValidation={customValidation} onSubmit={onSubmit} onCancel={vi.fn()} />
    );

    await delay();
    stdin.write('bbb');
    await delay();
    stdin.write(ENTER);
    await delay();

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('does not show checkmark/crossmark when no schema or customValidation', async () => {
    const { lastFrame, stdin } = render(<TextInput prompt="Name" onSubmit={vi.fn()} onCancel={vi.fn()} />);

    await delay();
    stdin.write('hello');
    await delay();

    const frame = lastFrame()!;
    expect(frame).not.toContain('\u2713');
    expect(frame).not.toContain('\u2717');
  });
});
