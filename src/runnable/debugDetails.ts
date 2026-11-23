import { AgentCoreCLIError } from "../errors";

interface ResponseMetadata {
  httpStatusCode?: number;
  requestId?: string;
}

type ServiceError = Error & { $metadata: ResponseMetadata };

function hasResponseMetadata(error: Error): error is ServiceError {
  const metadata: unknown = (error as Partial<ServiceError>).$metadata;
  return typeof metadata === "object" && metadata !== null;
}

function findServiceError(error: Error): ServiceError | undefined {
  const seen = new Set<Error>();
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    if (seen.has(current)) return undefined;
    seen.add(current);
    if (hasResponseMetadata(current)) return current;
  }
  return undefined;
}

function thrownName(error: AgentCoreCLIError): string {
  const wrapsPlainError = error.constructor === AgentCoreCLIError && error.cause instanceof Error;
  return wrapsPlainError ? (error.cause as Error).name : error.name;
}

export function formatDebugDetails(error: AgentCoreCLIError, logFile?: string): string {
  const service = findServiceError(error);
  const { httpStatusCode, requestId } = service?.$metadata ?? {};
  const summary = [
    `name: ${service?.name ?? thrownName(error)}`,
    httpStatusCode !== undefined && `status: ${httpStatusCode}`,
    requestId && `requestId: ${requestId}`,
  ].filter(Boolean);

  const lines = [`  ${summary.join("  ")}`];
  if (logFile) lines.push(`  details: ${logFile}`);
  return lines.join("\n");
}
