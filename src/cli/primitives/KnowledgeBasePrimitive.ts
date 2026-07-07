import { APP_DIR, ValidationError, findConfigRoot, serializeResult, toError } from '../../lib';
import type { Result } from '../../lib/result';
import type { AgentCoreProjectSpec, ConnectorFileDataSource, DataSource, KnowledgeBase } from '../../schema';
import { CONNECTOR_ID, KnowledgeBaseSchema } from '../../schema';
import { getErrorMessage } from '../errors';
import { isGatedFeaturesEnabled } from '../feature-flags';
import {
  type DataSourceTypeFlag,
  flagToWireType,
  isConnectorConfigType,
  readConnectorConfig,
} from '../operations/knowledge-base/connector-config';
import type { RemovalPreview } from '../operations/remove/types';
import { runCliCommand } from '../telemetry/cli-command-run.js';
import { requireTTY } from '../tui/guards/tty';
import { BasePrimitive } from './BasePrimitive';
import type { AddResult, AddScreenComponent, RemovableResource } from './types';
import type { Command } from '@commander-js/extra-typings';
import { copyFileSync, existsSync, mkdirSync } from 'fs';
import { basename, dirname, join, relative, resolve } from 'path';

/**
 * Options for adding a knowledge base resource.
 *
 * `agentcore add knowledge-base` creates the KB and its data sources. The
 * repeatable `--source` flag maps to entries in the KB's `dataSources` array.
 * Re-invoking `add` with an existing `--name` appends new data sources to the
 * existing entry (idempotent append).
 *
 * When `--gateway` is set, a connector-typed gateway target referencing this
 * KB by name is appended to `agentCoreGateways[name=X].targets[]`.
 *
 * Binding a pre-existing KB (one this project did not create) is done via the
 * gateway-target primitive: `agentcore add gateway-target --type connector
 * --connector bedrock-knowledge-bases --knowledge-base-id <id>`. That path
 * doesn't touch `knowledgeBases[]` at all.
 */
export interface AddKnowledgeBaseOptions {
  name: string;
  description?: string;
  /** Repeatable `--source` flag values (S3 URIs). Required for S3 data sources. */
  source?: string[];
  /** Repeatable `--connector-config` flag values. Required for non-S3 connectors. */
  connectorConfig?: string[];
  /** `--data-source-type` flag (s3 default, or web-crawler/confluence/...). */
  dataSourceType?: DataSourceTypeFlag;
  json?: boolean;
}

export interface AddKnowledgeBaseSuccess extends Record<string, unknown> {
  knowledgeBaseName: string;
  /** True if this invocation appended data sources to an existing KB; false on first creation. */
  appended: boolean;
  /** New data source URIs added by this invocation (matches the order of --source flags). */
  newDataSources: string[];
}

export type RemovableKnowledgeBase = RemovableResource;

/**
 * Cheap shape check for early errors at the CLI boundary. The Zod schema
 * (`S3DataSourceSchema`) is the canonical validator and runs on every
 * `KnowledgeBaseSchema.parse(...)` and on every `writeProjectSpec` —
 * keep these regexes in sync if either is edited.
 */
const S3_URI_PATTERN = /^s3:\/\/[^/]+(\/.*)?$/;

function isS3Uri(uri: string): boolean {
  return S3_URI_PATTERN.test(uri);
}

/**
 * Stable identity key for a data source across the discriminated union: S3
 * sources are keyed by their URI, non-S3 connector sources by their config
 * file path. Used for dedup and human-readable summaries.
 */
function dataSourceKey(ds: DataSource): string {
  return ds.type === 'S3' ? ds.uri : ds.connectorConfigFile;
}

/**
 * KB primitive. Owns the `agentcore.json` `knowledgeBases[]` lifecycle for
 * CLI-managed FMKB knowledge bases. Data sources are either S3 (inline
 * `--source` URIs) or non-S3 connectors (`--data-source-type` +
 * `--connector-config <file>`, e.g. Web Crawler / Confluence / SharePoint /
 * OneDrive / Google Drive). Connector configs are materialized under
 * `app/<kbName>/` and referenced by project-relative path.
 *
 * Existing-KB references — i.e. binding a pre-existing KB that this project
 * didn't create — are managed by the gateway-target primitive (`add
 * gateway-target --type connector`), since the only artifact written for that
 * case is a connector gateway target.
 */
export class KnowledgeBasePrimitive extends BasePrimitive<AddKnowledgeBaseOptions, RemovableKnowledgeBase> {
  readonly kind = 'knowledge-base';
  readonly label = 'Knowledge Base';
  readonly primitiveSchema = KnowledgeBaseSchema;

  async add(options: AddKnowledgeBaseOptions): Promise<AddResult<AddKnowledgeBaseSuccess>> {
    try {
      const sources = options.source ?? [];
      const connectorConfigs = options.connectorConfig ?? [];
      const wireType = flagToWireType(options.dataSourceType ?? 's3');
      const warnings: string[] = [];

      // Phase 1 — pure validation, no side effects (no file copy). Build the
      // would-be data sources for the connector path only after validating the
      // config files; for S3 just validate the URIs. The actual file copy is
      // deferred to phase 3 so a later validation failure (e.g. missing
      // gateway) never leaves a stray file behind.
      let buildDataSources: () => DataSource[];

      if (isConnectorConfigType(wireType)) {
        if (sources.length > 0) {
          throw new Error(`--source is only valid for S3. For ${wireType}, use --connector-config.`);
        }
        if (connectorConfigs.length === 0) {
          throw new Error(`--connector-config is required for --data-source-type ${options.dataSourceType}.`);
        }
        // Validate every config file up front (existence, JSON, type match,
        // secretArn advisory) before any copy happens. Also detect destination
        // basename collisions here: two configs in one invocation that resolve
        // to the same `app/<kb>/<basename>` would clobber each other on copy
        // (and produce identical connectorConfigFile values the schema rejects),
        // so reject the second BEFORE any file is written. Exact-source-path
        // duplicates are caught by the batch-dedup loop below with its own
        // message; here we only guard distinct sources sharing a basename.
        const seenSources = new Set<string>();
        const basenameToSource = new Map<string, string>();
        for (const cfgPath of connectorConfigs) {
          const { warnings: w } = readConnectorConfig(cfgPath, wireType);
          warnings.push(...w);

          const resolvedSrc = resolve(cfgPath);
          if (seenSources.has(resolvedSrc)) {
            // Same source twice — let the batch-dedup loop emit its message.
            continue;
          }
          seenSources.add(resolvedSrc);
          const base = basename(resolvedSrc);
          const prior = basenameToSource.get(base);
          if (prior) {
            throw new Error(
              `Connector config files '${prior}' and '${cfgPath}' would both be stored as 'app/${options.name}/${base}'. Rename one so their filenames differ.`
            );
          }
          basenameToSource.set(base, cfgPath);
        }
        buildDataSources = () =>
          connectorConfigs.map(cfgPath => {
            const stored = this.materializeConnectorConfig(options.name, cfgPath);
            return { type: wireType, connectorConfigFile: stored } as ConnectorFileDataSource;
          });
      } else {
        if (connectorConfigs.length > 0) {
          throw new Error('--connector-config is only valid for non-S3 data source types.');
        }
        if (sources.length === 0) {
          throw new Error('At least one --source is required for S3 data sources.');
        }
        // Cheap shape check up front so we error before reading agentcore.json.
        // The full bucket-name validation lives in S3DataSourceSchema.
        for (const uri of sources) {
          if (!isS3Uri(uri)) {
            throw new Error(`Invalid S3 URI: ${uri}. Expected s3://bucket[/prefix].`);
          }
        }
        buildDataSources = () => sources.map(uri => ({ type: 'S3', uri }));
      }

      // Reject duplicates inside this batch up front (S3 by uri, connector by
      // file path). The schema's superRefine catches this too at write time,
      // but its generic message is less actionable than naming the offender.
      const batchKeys = isConnectorConfigType(wireType)
        ? connectorConfigs.map(p => relative(dirname(this.configIO.getConfigRoot()), resolve(p)).split('\\').join('/'))
        : sources;
      const seenInBatch = new Set<string>();
      for (const key of batchKeys) {
        if (seenInBatch.has(key)) {
          throw new Error(`Duplicate data source in this invocation: ${key}`);
        }
        seenInBatch.add(key);
      }

      const project = await this.readProjectSpec();

      // Validate gateway exists (no auto-create) BEFORE any file copy.
      // Phase 3 — all validation passed; now materialize (copy connector
      // configs into app/<kb>/) and build the data sources.
      const newDataSources: DataSource[] = buildDataSources();

      const existing = project.knowledgeBases.find(kb => kb.name === options.name);
      if (existing) {
        return await this.appendToExisting(existing, project, newDataSources, options, warnings);
      }

      const kb: KnowledgeBase = KnowledgeBaseSchema.parse({
        name: options.name,
        ...(options.description && { description: options.description }),
        dataSources: newDataSources,
      });

      project.knowledgeBases.push(kb);
      await this.writeProjectSpec(project);

      if (!options.json) for (const w of warnings) console.warn(w);

      return {
        success: true,
        knowledgeBaseName: kb.name,
        appended: false,
        newDataSources: newDataSources.map(dataSourceKey),
      };
    } catch (err) {
      return { success: false, error: toError(err) };
    }
  }

  /**
   * Wires a KB into a gateway by emitting a bedrock-knowledge-bases connector
   * target with both Retrieve and AgenticRetrieveStream configurations.
   *
   * `--description` is intentionally not propagated to the target entry.
   * `AgentCoreGatewayTargetSchema` doesn't model a per-target description
   * (only the parent gateway has one).
   */

  /**
   * Append data sources to an existing KB entry. Errors loudly on conflicting
   * intent (e.g. trying to update description, or duplicate URI).
   */
  private async appendToExisting(
    existing: KnowledgeBase,
    project: Awaited<ReturnType<KnowledgeBasePrimitive['readProjectSpec']>>,
    newDataSources: DataSource[],
    options: AddKnowledgeBaseOptions,
    warnings: string[] = []
  ): Promise<AddResult<AddKnowledgeBaseSuccess>> {
    // Treat '' and undefined as "no description provided", so a user appending
    // a data source without re-passing --description doesn't trip the
    // update-not-supported guard.
    const descChanged =
      options.description !== undefined && options.description !== '' && options.description !== existing.description;
    if (descChanged) {
      throw new Error(
        `Knowledge base "${options.name}" already exists. Update operations are not supported in Wave 1; edit agentcore.json directly to change the description.`
      );
    }
    const existingKeys = new Set(existing.dataSources.map(dataSourceKey));
    for (const ds of newDataSources) {
      const key = dataSourceKey(ds);
      if (existingKeys.has(key)) {
        throw new Error(`Data source "${key}" already exists on knowledge-base "${options.name}".`);
      }
    }

    existing.dataSources.push(...newDataSources);
    await this.writeProjectSpec(project);

    if (!options.json) for (const w of warnings) console.warn(w);

    return {
      success: true,
      knowledgeBaseName: existing.name,
      appended: true,
      newDataSources: newDataSources.map(dataSourceKey),
    };
  }

  /**
   * Ensure the connector-config file lives under `app/<KBName>/` and return
   * its project-root-relative path. If the user's path already points inside
   * that folder, return it as-is; otherwise copy it in (announced to the user).
   */
  private materializeConnectorConfig(kbName: string, cfgPath: string): string {
    const projectRoot = dirname(this.configIO.getConfigRoot());
    const src = resolve(cfgPath);
    if (!existsSync(src)) {
      throw new Error(`Connector config file not found: ${cfgPath}`);
    }
    const destDir = join(projectRoot, APP_DIR, kbName);
    const dest = join(destDir, basename(src));
    const relToProject = (p: string) => relative(projectRoot, p).split('\\').join('/');

    if (resolve(src) === resolve(dest)) {
      return relToProject(dest);
    }
    // Defense-in-depth: never silently overwrite a different file already at
    // the destination (e.g. a prior data source on this KB whose config shares
    // this basename). The in-place case above already returned, so reaching
    // here with an existing dest means src !== dest.
    if (existsSync(dest)) {
      throw new Error(
        `Connector config '${cfgPath}' would overwrite the existing file at '${relToProject(dest)}'. Rename it so its filename differs.`
      );
    }
    mkdirSync(destDir, { recursive: true });
    copyFileSync(src, dest);
    console.error(`Copied connector config to ${relToProject(dest)}`);
    return relToProject(dest);
  }

  async remove(name: string): Promise<Result> {
    try {
      const project = await this.readProjectSpec();

      // Find the KB entry. Cascade-remove the per-KB Retrieve target on the
      // linked gateway, if any.
      const idx = project.knowledgeBases.findIndex(kb => kb.name === name);
      if (idx === -1) {
        throw new Error(`Knowledge base "${name}" not found.`);
      }
      const kb = project.knowledgeBases[idx]!;
      project.knowledgeBases.splice(idx, 1);
      if (kb.gateway) {
        this.removeConnectorTarget(project, kb.gateway, kb.name);
      }

      // Cascade-prune the removed KB out of every gateway target's
      // AgenticRetrieveStream configuration. Without this, the spec would be
      // unwriteable: the cross-spec validator rejects a configuration entry
      // that references a KB name not in knowledgeBases[] and isn't a literal
      // KB id. We keep the no-update rule for renames; remove is the one shape
      // where doing nothing leaves the spec in a state the schema won't write.
      this.pruneAgenticRetrieveReferences(project, name);

      await this.writeProjectSpec(project);
      return { success: true };
    } catch (err) {
      return { success: false, error: toError(err) };
    }
  }

  async previewRemove(name: string): Promise<RemovalPreview> {
    const project = await this.readProjectSpec();

    const kb = project.knowledgeBases.find(k => k.name === name);
    if (!kb) {
      throw new Error(`Knowledge base "${name}" not found.`);
    }
    const summary: string[] = [
      `Removing knowledge base: ${name}`,
      `  Data sources (${kb.dataSources.length}):`,
      ...kb.dataSources.map(ds => `    - ${dataSourceKey(ds)}`),
    ];
    if (kb.gateway) {
      summary.push(`  Gateway target: '${name}' on '${kb.gateway}' will be removed`);
    }

    const afterSpec = JSON.parse(JSON.stringify(project)) as typeof project;
    afterSpec.knowledgeBases = afterSpec.knowledgeBases.filter(k => k.name !== name);
    if (kb.gateway) {
      const gw = afterSpec.agentCoreGateways.find(g => g.name === kb.gateway);
      if (gw) gw.targets = gw.targets.filter(t => t.name !== name);
    }
    const pruneActions = this.pruneAgenticRetrieveReferences(afterSpec, name);
    for (const action of pruneActions) {
      if (action.removedTarget) {
        summary.push(
          `  Gateway "${action.gatewayName}" agentic-retrieve target '${action.targetName}' will be removed (was the last KB)`
        );
      } else {
        summary.push(
          `  Gateway "${action.gatewayName}" agentic-retrieve target '${action.targetName}' will lose KB '${name}'`
        );
      }
    }

    return {
      summary,
      directoriesToDelete: [],
      schemaChanges: [{ file: 'agentcore/agentcore.json', before: project, after: afterSpec }],
    };
  }

  /**
   * Walk every gateway's connector targets and drop kbReference from any
   * AgenticRetrieveStream configuration's retrievers[]. If retrievers empty
   * out and no other configurations remain, remove the target. Returns a list
   * of actions for callers that want to surface what changed.
   *
   * In the current model, AgenticRetrieveStream lives inside each
   * bedrock-knowledge-bases target, so removing the target via
   * removeConnectorTarget already handles the primary case. This method
   * catches cross-target references (e.g. a shared target with multiple KBs).
   */
  private pruneAgenticRetrieveReferences(
    project: AgentCoreProjectSpec,
    kbReference: string
  ): { gatewayName: string; targetName: string; removedTarget: boolean }[] {
    const actions: { gatewayName: string; targetName: string; removedTarget: boolean }[] = [];
    for (const gw of project.agentCoreGateways) {
      for (let tIdx = gw.targets.length - 1; tIdx >= 0; tIdx--) {
        const target = gw.targets[tIdx]!;
        if (target.targetType !== 'connector' || target.connectorId !== CONNECTOR_ID.BEDROCK_KNOWLEDGE_BASES) continue;
        const configs = target.configurations ?? [];

        // Prune AgenticRetrieveStream: remove this KB from retrievers[]
        const agenticCfgIdx = configs.findIndex(c => c.name === 'AgenticRetrieveStream');
        if (agenticCfgIdx !== -1) {
          const agenticCfg = configs[agenticCfgIdx]!;
          const pv = agenticCfg.parameterValues;
          const retrievers =
            (pv?.retrievers as { configuration: { knowledgeBase: { knowledgeBaseId: string } } }[] | undefined) ?? [];
          const ids = retrievers.map(r => r.configuration.knowledgeBase.knowledgeBaseId);
          if (ids.includes(kbReference)) {
            const remaining = ids.filter(id => id !== kbReference);
            if (remaining.length === 0) {
              configs.splice(agenticCfgIdx, 1);
            } else {
              agenticCfg.parameterValues!.retrievers = remaining.map(id => ({
                configuration: { knowledgeBase: { knowledgeBaseId: id } },
              }));
            }
          }
        }

        // Prune Retrieve: remove the config if it references this KB
        const retrieveCfgIdx = configs.findIndex(c => {
          return c.name === 'Retrieve' && c.parameterValues?.knowledgeBaseId === kbReference;
        });
        if (retrieveCfgIdx !== -1) {
          configs.splice(retrieveCfgIdx, 1);
        }

        // If no configurations remain, remove the whole target
        if (configs.length === 0) {
          gw.targets.splice(tIdx, 1);
          actions.push({ gatewayName: gw.name, targetName: target.name, removedTarget: true });
        } else if (agenticCfgIdx !== -1 || retrieveCfgIdx !== -1) {
          actions.push({ gatewayName: gw.name, targetName: target.name, removedTarget: false });
        }
      }
    }
    return actions;
  }

  async getRemovable(): Promise<RemovableKnowledgeBase[]> {
    try {
      const project = await this.readProjectSpec();
      return project.knowledgeBases.map(kb => ({ name: kb.name }));
    } catch {
      return [];
    }
  }

  /**
   * Remove a connector-typed gateway target by name. No-op if the target or
   * gateway is missing — that's fine because we may be cascading from a KB
   * whose gateway link was unwired manually.
   */
  private removeConnectorTarget(
    project: Awaited<ReturnType<KnowledgeBasePrimitive['readProjectSpec']>>,
    gatewayName: string,
    targetName: string
  ): void {
    const gateway = project.agentCoreGateways.find(g => g.name === gatewayName);
    if (!gateway) return;
    gateway.targets = gateway.targets.filter(t => t.name !== targetName);
  }

  registerCommands(addCmd: Command, removeCmd: Command): void {
    addCmd
      .command(this.kind, { hidden: !isGatedFeaturesEnabled() })
      .description('Add a knowledge base (FMKB) to the project, optionally wiring it to a gateway.')
      .option('--name <name>', 'Knowledge base name (default: kb-quick-start-xxxxx)')
      .option('--description <text>', 'Optional description (used for tool discovery)')
      .option(
        '--source <uri>',
        'S3 URI for a data source (s3://bucket[/prefix]). Repeatable for multiple data sources.',
        (val: string, acc: string[]) => [...acc, val],
        [] as string[]
      )
      .option(
        '--data-source-type <type>',
        'Data source type: s3 (default), web-crawler, confluence, sharepoint, onedrive, google-drive',
        's3'
      )
      .option(
        '--connector-config <path>',
        'Path to a JSON connector-config file (required for non-S3 types). Repeatable.',
        (val: string, acc: string[]) => [...acc, val],
        [] as string[]
      )
      .option('--json', 'Output as JSON [non-interactive]')
      .action(
        async (cliOptions: {
          name?: string;
          description?: string;
          source?: string[];
          dataSourceType?: string;
          connectorConfig?: string[];
          json?: boolean;
        }) => {
          if (!isGatedFeaturesEnabled()) {
            console.error('Knowledge bases are not yet available.');
            process.exit(1);
          }
          if (!findConfigRoot()) {
            console.error('No agentcore project found. Run `agentcore create` first.');
            process.exit(1);
          }

          // No-args (or only --json) → drop into the Add Knowledge Base TUI
          // wizard so the surface matches `agentcore add agent` /
          // `add memory`. --data-source-type defaults to 's3' from
          // Commander, so it's always populated; check the user-supplied
          // flags only.
          const userPassedAnyFlag =
            !!cliOptions.name ||
            !!cliOptions.description ||
            (cliOptions.source?.length ?? 0) > 0 ||
            (cliOptions.connectorConfig?.length ?? 0) > 0 ||
            !!cliOptions.json;
          if (!userPassedAnyFlag) {
            try {
              requireTTY();
              const [{ render }, { default: React }, { AddFlow }] = await Promise.all([
                import('ink'),
                import('react'),
                import('../tui/screens/add/AddFlow'),
              ]);
              const { clear, unmount } = render(
                React.createElement(AddFlow, {
                  isInteractive: false,
                  initialResource: 'knowledge-base',
                  onExit: () => {
                    clear();
                    unmount();
                    process.exit(0);
                  },
                })
              );
              return;
            } catch (error) {
              console.error(getErrorMessage(error));
              process.exit(1);
            }
          }

          await runCliCommand('add.knowledge-base', !!cliOptions.json, async () => {
            let resolvedName = cliOptions.name;
            if (!resolvedName) {
              const project = await this.readProjectSpec();
              const existingNames = new Set(project.knowledgeBases.map(kb => kb.name));
              let candidate: string;
              do {
                candidate = `kb-quick-start-${Math.random().toString(36).slice(2, 7)}`;
              } while (existingNames.has(candidate));
              resolvedName = candidate;
            }

            const result = await this.add({
              name: resolvedName,
              description: cliOptions.description,
              source: cliOptions.source,
              dataSourceType: cliOptions.dataSourceType as DataSourceTypeFlag | undefined,
              connectorConfig: cliOptions.connectorConfig,
              json: cliOptions.json,
            });

            if (!result.success) {
              throw result.error;
            }

            if (cliOptions.json) {
              console.log(JSON.stringify(serializeResult(result)));
            } else if (result.appended) {
              for (const uri of result.newDataSources) {
                console.log(`Added data source '${uri}' to knowledge-base '${result.knowledgeBaseName}'`);
              }
            } else {
              console.log(`Added knowledge base '${result.knowledgeBaseName}'`);
              for (const uri of result.newDataSources) {
                console.log(`  with data source '${uri}'`);
              }
            }

            return {
              data_source_count: result.newDataSources.length,
              data_source_type: cliOptions.dataSourceType ?? 's3',
              has_description: !!cliOptions.description,
              is_append: result.appended,
            };
          });
        }
      );

    removeCmd
      .command(this.kind, { hidden: !isGatedFeaturesEnabled() })
      .description('Remove a knowledge base from the project')
      .option('--name <name>', 'Knowledge base name')
      .option('--json', 'Output as JSON [non-interactive]')
      .action(async (cliOptions: { name?: string; json?: boolean }) => {
        if (!isGatedFeaturesEnabled()) {
          console.error('Knowledge bases are not yet available.');
          process.exit(1);
        }
        if (!findConfigRoot()) {
          console.error('No agentcore project found. Run `agentcore create` first.');
          process.exit(1);
        }
        await runCliCommand('remove.knowledge-base', !!cliOptions.json, async () => {
          if (!cliOptions.name) {
            throw new ValidationError('A --name is required for `agentcore remove knowledge-base`.');
          }
          const result = await this.remove(cliOptions.name);
          if (!result.success) {
            throw result.error;
          }
          if (cliOptions.json) {
            console.log(JSON.stringify(serializeResult(result)));
          } else {
            console.log(`Removed knowledge base '${cliOptions.name}'`);
          }
          return {};
        });
      });
  }

  addScreen(): AddScreenComponent {
    // Wave 1: CLI-only. TUI lands in Plan C.
    return null;
  }
}
