import { TransactionSearchNotEnabledError } from "../../../errors";
import type { CoreOptions } from "../../../core/types";
import type { Core } from "../../types";

// A/B test runs score sessions from the `aws/spans` log group, which only
// CloudWatch Transaction Search populates. Fail fast with an actionable error
// rather than creating a test that can never produce results.
export async function requireTransactionSearch(core: Core, options: CoreOptions): Promise<void> {
  if (!(await core.observability.isTransactionSearchEnabled(options))) {
    throw new TransactionSearchNotEnabledError();
  }
}
