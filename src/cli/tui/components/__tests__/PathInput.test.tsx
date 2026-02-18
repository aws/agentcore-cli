import { PathInput } from '../PathInput.js';
import { render } from 'ink-testing-library';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mockReaddirSync = vi.hoisted(() => vi.fn());
const mockExistsSync = vi.hoisted(() => vi.fn());
const mockStatSync = vi.hoisted(() => vi.fn());

vi.mock('node:fs', () => ({
  readdirSync: mockReaddirSync,
  existsSync: mockExistsSync,
  statSync: mockStatSync,
}));

const ENTER = '\r';
const ESCAPE = '\x1B';
const ARROW_UP = '\x1B[A';
const ARROW_DOWN = '\x1B[B';
const ARROW_RIGHT = '\x1B[C';
const ARROW_LEFT = '\x1B[D';
const TAB = '\t';

function delay(ms = 50) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

afterEach(() => {
  vi.restoreAllMocks();
  mockReaddirSync.mockReset();
  mockExistsSync.mockReset();
  mockStatSync.mockReset();
});

function setupEmptyFs() {
  mockReaddirSync.mockReturnValue([]);
  mockExistsSync.mockReturnValue(false);
}

function makeDirent(name: string, isDir: boolean) {
  return {
    name,
    isDirectory: () => isDir,
    isFile: () => !isDir,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
    isSymbolicLink: () => false,
    parentPath: '/base',
    path: '/base',
  };
}

describe('PathInput', () => {
  it('renders "Select a file:" by default', () => {
    setupEmptyFs();
    const { lastFrame } = render(<PathInput onSubmit={vi.fn()} onCancel={vi.fn()} basePath="/base" />);

    expect(lastFrame()).toContain('Select a file:');
  });

  it('renders "Select a directory:" when pathType is directory', () => {
    setupEmptyFs();
    const { lastFrame } = render(
      <PathInput onSubmit={vi.fn()} onCancel={vi.fn()} basePath="/base" pathType="directory" />
    );

    expect(lastFrame()).toContain('Select a directory:');
  });

  it('shows placeholder when value is empty', () => {
    setupEmptyFs();
    const { lastFrame } = render(
      <PathInput onSubmit={vi.fn()} onCancel={vi.fn()} basePath="/base" placeholder="Enter path here" />
    );

    expect(lastFrame()).toContain('Enter path here');
  });

  it('shows help text', () => {
    setupEmptyFs();
    const { lastFrame } = render(<PathInput onSubmit={vi.fn()} onCancel={vi.fn()} basePath="/base" />);

    expect(lastFrame()).toContain('move');
    expect(lastFrame()).toContain('open');
    expect(lastFrame()).toContain('back');
    expect(lastFrame()).toContain('Enter submit');
    expect(lastFrame()).toContain('Esc cancel');
  });

  it('calls onCancel on Escape', async () => {
    setupEmptyFs();
    const onCancel = vi.fn();
    const { stdin } = render(<PathInput onSubmit={vi.fn()} onCancel={onCancel} basePath="/base" />);

    await delay();
    stdin.write(ESCAPE);
    await delay();

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('shows error when submitting empty value', async () => {
    setupEmptyFs();
    const onSubmit = vi.fn();
    const { lastFrame, stdin } = render(<PathInput onSubmit={onSubmit} onCancel={vi.fn()} basePath="/base" />);

    await delay();
    stdin.write(ENTER);
    await delay();

    expect(lastFrame()).toContain('Please enter a path');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('shows error for invalid path on submit', async () => {
    mockReaddirSync.mockReturnValue([]);
    mockExistsSync.mockReturnValue(false);

    const onSubmit = vi.fn();
    const { lastFrame, stdin } = render(
      <PathInput onSubmit={onSubmit} onCancel={vi.fn()} basePath="/base" initialValue="nonexistent" />
    );

    await delay();
    stdin.write(ENTER);
    await delay();

    expect(lastFrame()).toContain('is not a valid path');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('calls onSubmit with valid path', async () => {
    mockReaddirSync.mockReturnValue([]);
    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockReturnValue({ isDirectory: () => true });

    const onSubmit = vi.fn();
    const { stdin } = render(
      <PathInput onSubmit={onSubmit} onCancel={vi.fn()} basePath="/base" initialValue="mydir" pathType="directory" />
    );

    await delay();
    stdin.write(ENTER);
    await delay();

    expect(onSubmit).toHaveBeenCalledWith('mydir');
  });

  it('calls onSubmit for valid file path', async () => {
    mockReaddirSync.mockReturnValue([]);
    mockExistsSync.mockReturnValue(true);

    const onSubmit = vi.fn();
    const { stdin } = render(
      <PathInput onSubmit={onSubmit} onCancel={vi.fn()} basePath="/base" initialValue="file.txt" pathType="file" />
    );

    await delay();
    stdin.write(ENTER);
    await delay();

    expect(onSubmit).toHaveBeenCalledWith('file.txt');
  });

  it('shows completions dropdown', () => {
    mockReaddirSync.mockReturnValue([makeDirent('src', true), makeDirent('readme.md', false)]);

    const { lastFrame } = render(<PathInput onSubmit={vi.fn()} onCancel={vi.fn()} basePath="/base" />);

    const frame = lastFrame()!;
    expect(frame).toContain('src/');
    expect(frame).toContain('readme.md');
  });

  it('hides dotfiles from completions', () => {
    mockReaddirSync.mockReturnValue([
      makeDirent('.hidden', true),
      makeDirent('.gitignore', false),
      makeDirent('visible', true),
    ]);

    const { lastFrame } = render(<PathInput onSubmit={vi.fn()} onCancel={vi.fn()} basePath="/base" />);

    const frame = lastFrame()!;
    expect(frame).toContain('visible/');
    expect(frame).not.toContain('.hidden');
    expect(frame).not.toContain('.gitignore');
  });

  it('navigates dropdown with arrow keys', async () => {
    mockReaddirSync.mockReturnValue([makeDirent('alpha', true), makeDirent('beta', true), makeDirent('gamma', true)]);

    const { lastFrame, stdin } = render(<PathInput onSubmit={vi.fn()} onCancel={vi.fn()} basePath="/base" />);

    await delay();

    // Initially first item is selected
    let frame = lastFrame()!;
    const alphaLine = frame.split('\n').find(l => l.includes('alpha'));
    expect(alphaLine).toContain('❯');

    // Press down arrow to select second item
    stdin.write(ARROW_DOWN);
    await delay();

    frame = lastFrame()!;
    const betaLine = frame.split('\n').find(l => l.includes('beta'));
    expect(betaLine).toContain('❯');

    // Press up arrow to go back to first
    stdin.write(ARROW_UP);
    await delay();

    frame = lastFrame()!;
    const alphaLineAgain = frame.split('\n').find(l => l.includes('alpha'));
    expect(alphaLineAgain).toContain('❯');
  });

  it('selects completion with right arrow', async () => {
    mockReaddirSync.mockReturnValue([makeDirent('src', true), makeDirent('lib', true)]);

    const { lastFrame, stdin } = render(<PathInput onSubmit={vi.fn()} onCancel={vi.fn()} basePath="/base" />);

    await delay();
    stdin.write(ARROW_RIGHT);
    await delay();

    expect(lastFrame()).toContain('src/');
  });

  it('selects completion with tab', async () => {
    mockReaddirSync.mockReturnValue([makeDirent('docs', true)]);

    const { lastFrame, stdin } = render(<PathInput onSubmit={vi.fn()} onCancel={vi.fn()} basePath="/base" />);

    await delay();
    stdin.write(TAB);
    await delay();

    // After tab the value should contain docs/
    expect(lastFrame()).toContain('docs/');
  });

  it('goes back with left arrow', async () => {
    mockReaddirSync.mockReturnValue([]);

    const { lastFrame, stdin } = render(
      <PathInput onSubmit={vi.fn()} onCancel={vi.fn()} basePath="/base" initialValue="src/lib/" />
    );

    await delay();
    // Left arrow should go back one level
    stdin.write(ARROW_LEFT);
    await delay();

    // Should show src/ (parent) as the current value, not src/lib/
    const frame = lastFrame()!;
    expect(frame).toContain('src/');
    expect(frame).not.toContain('src/lib/');
  });

  it('shows error when directory path points to a file', async () => {
    mockReaddirSync.mockReturnValue([]);
    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockReturnValue({ isDirectory: () => false });

    const onSubmit = vi.fn();
    const { lastFrame, stdin } = render(
      <PathInput onSubmit={onSubmit} onCancel={vi.fn()} basePath="/base" initialValue="file.txt" pathType="directory" />
    );

    await delay();
    stdin.write(ENTER);
    await delay();

    expect(lastFrame()).toContain('is not a directory');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('only shows directories when pathType is directory', () => {
    mockReaddirSync.mockReturnValue([makeDirent('mydir', true), makeDirent('myfile.txt', false)]);

    const { lastFrame } = render(
      <PathInput onSubmit={vi.fn()} onCancel={vi.fn()} basePath="/base" pathType="directory" />
    );

    const frame = lastFrame()!;
    expect(frame).toContain('mydir/');
    expect(frame).not.toContain('myfile.txt');
  });

  it('clears error on next input', async () => {
    mockReaddirSync.mockReturnValue([]);
    mockExistsSync.mockReturnValue(false);

    const { lastFrame, stdin } = render(<PathInput onSubmit={vi.fn()} onCancel={vi.fn()} basePath="/base" />);

    await delay();
    stdin.write(ENTER);
    await delay();

    expect(lastFrame()).toContain('Please enter a path');

    // Type something to clear error
    stdin.write('a');
    await delay();

    expect(lastFrame()).not.toContain('Please enter a path');
  });

  it('wraps around when navigating past the last item', async () => {
    mockReaddirSync.mockReturnValue([makeDirent('aaa', true), makeDirent('bbb', true)]);

    const { lastFrame, stdin } = render(<PathInput onSubmit={vi.fn()} onCancel={vi.fn()} basePath="/base" />);

    await delay();
    // Down twice wraps to first
    stdin.write(ARROW_DOWN);
    await delay();
    stdin.write(ARROW_DOWN);
    await delay();

    const frame = lastFrame()!;
    const aaaLine = frame.split('\n').find(l => l.includes('aaa'));
    expect(aaaLine).toContain('❯');
  });

  it('sorts directories before files', () => {
    mockReaddirSync.mockReturnValue([
      makeDirent('zfile.txt', false),
      makeDirent('adir', true),
      makeDirent('afile.txt', false),
    ]);

    const { lastFrame } = render(<PathInput onSubmit={vi.fn()} onCancel={vi.fn()} basePath="/base" />);

    const frame = lastFrame()!;
    const lines = frame.split('\n');
    const dirLine = lines.findIndex(l => l.includes('adir'));
    const fileLine = lines.findIndex(l => l.includes('afile.txt'));
    expect(dirLine).toBeLessThan(fileLine);
  });
});
