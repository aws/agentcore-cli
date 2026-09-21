export const ExitCode = {
  SUCCESS: 0,
  FAILURE: 1,
  USAGE: 2,
  INTERRUPTED: 130,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];
