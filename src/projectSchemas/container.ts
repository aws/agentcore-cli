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
