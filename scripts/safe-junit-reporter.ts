import { JUnitReporter } from 'vitest/node';

export default class SafeJUnitReporter extends JUnitReporter {
  constructor() {
    super({ includeConsoleOutput: false });
  }
}
