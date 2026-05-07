import type { AgentCoreProjectSpec } from '../../../schema';
import { NAME_REGEX } from './constants';
import { executeCdkImportPipeline } from './import-pipeline';
import { failResult, findResourceInDeployedState, resolveImportContext, toStackName } from './import-utils';
import { findLogicalIdByProperty, findLogicalIdsByType } from './template-utils';
import type { ImportResourceOptions, ImportResourceResult, ResourceImportDescriptor } from './types';

/**
 * Generic import orchestrator. Owns the full 10-step sequence shared by all
 * single-resource import commands (runtime, memory, evaluator, online-eval).
 *
 * Each resource type provides a descriptor declaring its specific behavior.
 */
export async function executeResourceImport<TDetail, TSummary>(
  descriptor: ResourceImportDescriptor<TDetail, TSummary>,
  options: ImportResourceOptions
): Promise<ImportResourceResult> {
  let configSnapshot: AgentCoreProjectSpec | undefined;
  let configWritten = false;
  let importCtx: Awaited<ReturnType<typeof resolveImportContext>> | undefined;

  const rollback = async () => {
    if (configWritten && configSnapshot && importCtx) {
      try {
        await importCtx.ctx.configIO.writeProjectSpec(configSnapshot);
      } catch (err) {
        console.warn(`Warning: Could not restore agentcore.json: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (descriptor.rollbackExtra) {
      await descriptor.rollbackExtra();
    }
  };

  try {
    // 1-2. Validate project context and resolve target
    importCtx = await resolveImportContext(options, descriptor.logCommand);
    const { ctx, target, logger, onProgress } = importCtx;

    // 3. Fetch resource from AWS
    logger.startStep(`Fetch ${descriptor.displayName} from AWS`);
    let resourceId: string;

    if (options.arn) {
      resourceId = descriptor.parseResourceId(options.arn, target);
    } else {
      onProgress(`Listing ${descriptor.displayName}s in your account...`);
      const summaries = await descriptor.listResources(target.region);

      if (summaries.length === 0) {
        return failResult(logger, `No ${descriptor.displayName}s found in your account.`, descriptor.resourceType, '');
      }

      if (summaries.length === 1) {
        resourceId = descriptor.extractSummaryId(summaries[0]!);
        onProgress(descriptor.formatAutoSelectMessage(summaries[0]!));
      } else {
        console.log(`\nFound ${summaries.length} ${descriptor.displayName}(s):\n`);
        for (let i = 0; i < summaries.length; i++) {
          console.log(descriptor.formatListItem(summaries[i]!, i));
        }
        console.log('');

        return failResult(
          logger,
          `Multiple ${descriptor.displayName}s found. Use --arn <arn> to specify which ${descriptor.displayName} to import.`,
          descriptor.resourceType,
          ''
        );
      }
    }

    onProgress(`Fetching ${descriptor.displayName} details for ${resourceId}...`);
    const detail = await descriptor.getDetail(target.region, resourceId);

    if (descriptor.extractDetailStatus(detail) !== descriptor.readyStatus) {
      onProgress(
        `Warning: ${descriptor.displayName} status is ${descriptor.extractDetailStatus(detail)}, not ${descriptor.readyStatus}`
      );
    }

    // 4. Validate name
    let localName = options.name ?? descriptor.extractDetailName(detail);
    if (!NAME_REGEX.test(localName)) {
      return failResult(
        logger,
        `Invalid name "${localName}". Name must start with a letter and contain only letters, numbers, and underscores (max 48 chars).`,
        descriptor.resourceType,
        localName
      );
    }
    onProgress(`${descriptor.displayName}: ${descriptor.extractDetailName(detail)} → local name: ${localName}`);
    logger.endStep('success');

    // 5. Check for duplicates
    logger.startStep('Check for duplicates');
    const projectSpec = await ctx.configIO.readProjectSpec();
    const existingNames = new Set(descriptor.getExistingNames(projectSpec));
    if (existingNames.has(localName)) {
      return failResult(
        logger,
        `${descriptor.displayName} "${localName}" already exists in the project. Use --name to specify a different local name.`,
        descriptor.resourceType,
        localName
      );
    }
    const targetName = target.name ?? 'default';
    const existingResource = await findResourceInDeployedState(
      ctx.configIO,
      targetName,
      descriptor.resourceType,
      resourceId
    );
    const isReimport = !!existingResource;
    if (existingResource) {
      if (!options.name) {
        localName = existingResource;
      }
      onProgress(`${descriptor.displayName} already managed by CloudFormation — re-adding to project config`);
    }
    logger.endStep('success');

    // 6. Optional pre-write hook
    if (descriptor.beforeConfigWrite) {
      const hookResult = await descriptor.beforeConfigWrite({
        detail,
        localName,
        projectSpec,
        ctx,
        target,
        options,
        onProgress,
        logger,
      });
      if (hookResult) {
        return hookResult;
      }
    }

    // 7. Update project config
    logger.startStep('Update project config');
    configSnapshot = JSON.parse(JSON.stringify(projectSpec)) as AgentCoreProjectSpec;
    descriptor.addToProjectSpec(detail, localName, projectSpec);
    await ctx.configIO.writeProjectSpec(projectSpec);
    configWritten = true;
    onProgress(`Added ${descriptor.displayName} "${localName}" to agentcore.json`);
    logger.endStep('success');

    // 8. CDK build → synth → bootstrap → phase 1 → phase 2 → update state
    logger.startStep('Build and synth CDK');
    const stackName = toStackName(ctx.projectName, targetName);

    const pipelineResult = await executeCdkImportPipeline({
      projectRoot: ctx.projectRoot,
      stackName,
      target,
      configIO: ctx.configIO,
      targetName,
      onProgress,
      buildResourcesToImport: (synthTemplate, deployedTemplate) => {
        const deployedIds = new Set(Object.keys(deployedTemplate.Resources));

        // Try matching by name property (plain name first, then prefixed)
        let logicalId = findLogicalIdByProperty(
          synthTemplate,
          descriptor.cfnResourceType,
          descriptor.cfnNameProperty,
          localName,
          { excludeLogicalIds: deployedIds }
        );

        if (!logicalId) {
          const prefixedName = `${ctx.projectName}_${localName}`;
          logicalId = findLogicalIdByProperty(
            synthTemplate,
            descriptor.cfnResourceType,
            descriptor.cfnNameProperty,
            prefixedName,
            { excludeLogicalIds: deployedIds }
          );
        }

        // Fall back to single resource by type
        if (!logicalId) {
          const allLogicalIds = findLogicalIdsByType(synthTemplate, descriptor.cfnResourceType).filter(
            id => !deployedIds.has(id)
          );
          if (allLogicalIds.length === 1) {
            logicalId = allLogicalIds[0];
          }
        }

        if (!logicalId) {
          return [];
        }

        return [
          {
            resourceType: descriptor.cfnResourceType,
            logicalResourceId: logicalId,
            resourceIdentifier: { [descriptor.cfnIdentifierKey]: resourceId },
          },
        ];
      },
      deployedStateEntries: [descriptor.buildDeployedStateEntry(localName, resourceId, detail)],
    });

    if (pipelineResult.noResources) {
      if (isReimport) {
        logger.endStep('success');
        logger.finalize(true);
        return {
          success: true,
          resourceType: descriptor.resourceType,
          resourceName: localName,
          resourceId,
          logPath: logger.getRelativeLogPath(),
        };
      }
      const error = `Could not find logical ID for ${descriptor.displayName} "${localName}" in CloudFormation template`;
      await rollback();
      return failResult(logger, error, descriptor.resourceType, localName);
    }

    if (!pipelineResult.success) {
      await rollback();
      logger.endStep('error', pipelineResult.error);
      logger.finalize(false);
      return {
        success: false,
        error: pipelineResult.error,
        resourceType: descriptor.resourceType,
        resourceName: localName,
        logPath: logger.getRelativeLogPath(),
      };
    }
    logger.endStep('success');

    // 9. Return success
    logger.finalize(true);
    return {
      success: true,
      resourceType: descriptor.resourceType,
      resourceName: localName,
      resourceId,
      logPath: logger.getRelativeLogPath(),
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    await rollback();
    if (importCtx) {
      importCtx.logger.log(message, 'error');
      importCtx.logger.finalize(false);
    }
    return {
      success: false,
      error: message,
      resourceType: descriptor.resourceType,
      resourceName: options.name ?? '',
      logPath: importCtx?.logger.getRelativeLogPath(),
    };
  }
}
