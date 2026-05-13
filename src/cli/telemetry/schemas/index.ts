export {
  CommandResultSchema,
  Count,
  ErrorName,
  ErrorSource,
  ExitReason,
  FailureResult,
  Mode,
  SuccessResult,
  CancelResult,
  type CommandResult,
} from './common-shapes.js';
export { ResourceAttributesSchema, type ResourceAttributes } from './common-attributes.js';
export { COMMAND_SCHEMAS, deriveCommandGroup, type Command, type CommandAttrs } from './command-run.js';
