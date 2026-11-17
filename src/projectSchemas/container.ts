import { z } from "zod";

export const CONTAINER_URI_PATTERN =
  /^(([0-9]{12})\.dkr\.ecr\.([a-z0-9-]+)\.amazonaws\.com(\.cn)?|public\.ecr\.aws)\/((?:[a-z0-9]+(?:[._-][a-z0-9]+)*\/)*[a-z0-9]+(?:[._-][a-z0-9]+)*)(?::([^:@]{1,300}))?(?:@(.+))?$/;

export const MAX_CONTAINER_URI_LENGTH = 1024;

export const ContainerUriSchema = z
  .string()
  .min(1)
  .max(MAX_CONTAINER_URI_LENGTH)
  .regex(
    CONTAINER_URI_PATTERN,
    "containerUri must be an ECR image URI (12-digit private ECR or public.ecr.aws)",
  );

/** The parts of an ECR image URI that IAM policies scope to. */
export type ContainerImage =
  | { registry: "private"; account: string; region: string; repository: string }
  | { registry: "public"; repository: string };

/** Splits a URI that {@link ContainerUriSchema} accepts; undefined for anything else. */
export function parseContainerUri(uri: string): ContainerImage | undefined {
  const match = CONTAINER_URI_PATTERN.exec(uri);
  if (!match) return undefined;
  const [, , account, region, , repository] = match;
  return account && region
    ? { registry: "private", account, region, repository: repository! }
    : { registry: "public", repository: repository! };
}
