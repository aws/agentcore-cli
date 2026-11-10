export const TIMEOUT_MS = {
  PROJECT_CREATE: 3 * 60 * 1000,
  PROJECT_DEV: 3 * 60 * 1000,
  PROJECT_DEPLOY: 10 * 60 * 1000,
  PROJECT_ADD: 3 * 60 * 1000,
  PROJECT_REMOVE: 60 * 1000,
  PROJECT_INVOKE: 3 * 60 * 1000,
  // A disable waits 20 minutes for in-flight writers before it deletes anything.
  INSIGHT_STORE_SETTLE: 30 * 60 * 1000,
};
