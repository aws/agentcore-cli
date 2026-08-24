import { InputValidationError } from "../../../errors";

export class InsightsJob {
  static is(job: { insights?: unknown[] }): boolean {
    return Boolean(job.insights?.length);
  }

  static assert(job: { insights?: unknown[] }, id: string): void {
    if (!InsightsJob.is(job)) {
      throw new InputValidationError(`batch evaluation "${id}" is not a batch insights run`);
    }
  }
}
