import { createHarnessEndpointHandler } from "../../../core/dev/harness/endpoint";
import { HarnessDevHosts } from "../../../core/dev/harness/hosts";
import { errorMessage } from "../../../core/dev/inspector/respond";
import { rewriteOtelEndpointForContainer } from "../../../core/dev/otel/collector";
import { DEV_PORTS, findFreePort } from "../../../core/dev/port";
import { devWorkloadIdentityName } from "../../../core/identity";
import { AgentCoreCLIError, ProjectStateError } from "../../../errors";
import type { HarnessRegistryEntry } from "../../../projectSchemas/harness";
import type { Core } from "../../types";
import type { Project, ResolvedDeployedResource } from "../types";
import type { DevProjectHandlerConfig } from ".";
import type { DevTraceCollector, HarnessDevAws } from "./types";

export type DevHarnessHosts = Pick<
  HarnessDevHosts,
  "invoke" | "events" | "setHarnesses" | "snapshot" | "start" | "pullImage"
>;

export async function startHarnessHosts(
  config: Pick<
    DevProjectHandlerConfig,
    "checkPort" | "startServer" | "loadDevEnvironment" | "harnessDevAws" | "createHarnessHosts"
  >,
  project: Project,
  harnesses: HarnessRegistryEntry[],
  options: {
    region: string;
    target: string;
    port?: number;
    collector?: DevTraceCollector;
    signal: AbortSignal;
  },
): Promise<{ hosts: DevHarnessHosts; port: number }> {
  const endpoint = await findFreePort(
    DEV_PORTS.HARNESS,
    options.port,
    config.checkPort,
    options.signal,
  );
  const ports = new Map<string, number>();
  let nextPort = endpoint.port + 1;
  let allocating: Promise<unknown> = Promise.resolve();
  const create = config.createHarnessHosts ?? ((hostsConfig) => new HarnessDevHosts(hostsConfig));
  const hosts = create({
    project: { name: project.name, rootPath: project.rootPath },
    harnesses,
    region: options.region,
    aws: config.harnessDevAws(project, options.target, options.region),
    signal: options.signal,
    environment: async ({ spec }) => {
      const { env } = await config.loadDevEnvironment({
        projectRoot: project.rootPath,
        env: spec.environmentVariables,
        region: options.region,
      });
      const otel = options.collector
        ? rewriteOtelEndpointForContainer({
            ...options.collector.envVars,
            OTEL_SERVICE_NAME: spec.name,
          })
        : {};
      return { ...env, ...otel };
    },
    hostPort: (name) => {
      const port = allocating.then(async () => {
        const cached = ports.get(name);
        if (cached !== undefined) return cached;
        const { port } = await findFreePort(nextPort, undefined, config.checkPort, options.signal);
        ports.set(name, port);
        nextPort = port + 1;
        return port;
      });
      allocating = port.catch(() => {});
      return port;
    },
  });
  const server = await config.startServer(createHarnessEndpointHandler(hosts), {
    port: endpoint.port,
    signal: options.signal,
  });
  return { hosts, port: server.port };
}

export function createHarnessDevAws(
  core: Pick<Core, "projectManager" | "harness" | "identity">,
  project: Project,
  target: string,
  region: string,
): HarnessDevAws {
  const identityName = devWorkloadIdentityName(project.name, target);
  const identityCall = async <T>(call: (options: { region: string }) => Promise<T>): Promise<T> => {
    try {
      const resolved = await core.projectManager.resolveTarget(project, { target });
      return await call({ region: resolved?.region ?? region });
    } catch (error) {
      throw new AgentCoreCLIError(
        `Workload identity '${identityName}' call failed: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  };
  let ensured: Promise<void> | undefined;
  const ensure = async (): Promise<boolean> => {
    if (ensured) return ensured.then(() => false);
    const pending = identityCall((options) =>
      core.identity.ensureWorkloadIdentity(identityName, options),
    );
    ensured = pending.then(
      () => undefined,
      () => {
        ensured = undefined;
      },
    );
    return (await pending).created;
  };
  const token = () =>
    identityCall((options) => core.identity.getWorkloadAccessToken(identityName, options));
  return {
    deployedHarness: async (name) => {
      let deployed: ResolvedDeployedResource;
      try {
        deployed = await core.projectManager.resolveDeployedResource(project, {
          target,
          resourceType: "harness",
          name,
        });
      } catch (error) {
        if (error instanceof ProjectStateError) return undefined;
        throw error;
      }
      const response = await core.harness.getHarness(deployed.id, {
        region: deployed.target.region,
        credentials: deployed.credentialProvider,
      });
      return response.harness!;
    },
    workloadAccessToken: async () => {
      let created = await ensure();
      let accessToken: string;
      try {
        accessToken = await token();
      } catch {
        ensured = undefined;
        created = (await ensure()) || created;
        accessToken = await token();
      }
      return { token: accessToken, createdIdentity: created ? identityName : undefined };
    },
  };
}
