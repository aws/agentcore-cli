import { COMMAND_DESCRIPTIONS } from '../../tui/copy';
import { addTag, listTags, removeDefaultTag, removeTag, setDefaultTag } from './action';
import type { Command } from '@commander-js/extra-typings';
import { Text, render } from 'ink';

export const registerTag = (program: Command) => {
  const tag = program.command('tag').description(COMMAND_DESCRIPTIONS.tag);

  tag
    .command('list')
    .description('List tags on all taggable resources')
    .option('--resource <ref>', 'Filter by resource (type:name, e.g. agent:MyAgent)')
    .option('--json', 'Output as JSON')
    .action(async options => {
      try {
        const result = await listTags(options.resource);
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log('Project Defaults:');
          const defaults = Object.entries(result.projectDefaults);
          if (defaults.length === 0) {
            console.log('  (none)');
          } else {
            for (const [k, v] of defaults) {
              console.log(`  ${k} = ${v}`);
            }
          }
          console.log();
          if (result.resources.length === 0) {
            console.log('No taggable resources found.');
          } else {
            for (const resource of result.resources) {
              console.log(`${resource.type}:${resource.name}`);
              const entries = Object.entries(resource.tags);
              if (entries.length === 0) {
                console.log('  (no tags)');
              } else {
                for (const [k, v] of entries) {
                  console.log(`  ${k} = ${v}`);
                }
              }
            }
          }
        }
      } catch (err) {
        render(<Text color="red">{err instanceof Error ? err.message : String(err)}</Text>);
        process.exit(1);
      }
    });

  tag
    .command('add')
    .description('Add a tag to a resource')
    .requiredOption('--resource <ref>', 'Resource reference (type:name, e.g. agent:MyAgent)')
    .requiredOption('--key <key>', 'Tag key')
    .requiredOption('--value <value>', 'Tag value')
    .option('--json', 'Output as JSON')
    .action(async options => {
      try {
        const result = await addTag(options.resource, options.key, options.value);
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          render(
            <Text color="green">
              Tag added: {options.key} = {options.value} on {options.resource}
            </Text>
          );
        }
      } catch (err) {
        render(<Text color="red">{err instanceof Error ? err.message : String(err)}</Text>);
        process.exit(1);
      }
    });

  tag
    .command('remove')
    .description('Remove a tag from a resource')
    .requiredOption('--resource <ref>', 'Resource reference (type:name, e.g. agent:MyAgent)')
    .requiredOption('--key <key>', 'Tag key to remove')
    .option('--json', 'Output as JSON')
    .action(async options => {
      try {
        const result = await removeTag(options.resource, options.key);
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          render(
            <Text color="green">
              Tag removed: {options.key} from {options.resource}
            </Text>
          );
        }
      } catch (err) {
        render(<Text color="red">{err instanceof Error ? err.message : String(err)}</Text>);
        process.exit(1);
      }
    });

  tag
    .command('set-defaults')
    .description('Set a project-level default tag')
    .requiredOption('--key <key>', 'Tag key')
    .requiredOption('--value <value>', 'Tag value')
    .option('--json', 'Output as JSON')
    .action(async options => {
      try {
        const result = await setDefaultTag(options.key, options.value);
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          render(
            <Text color="green">
              Default tag set: {options.key} = {options.value}
            </Text>
          );
        }
      } catch (err) {
        render(<Text color="red">{err instanceof Error ? err.message : String(err)}</Text>);
        process.exit(1);
      }
    });

  tag
    .command('remove-defaults')
    .description('Remove a project-level default tag')
    .requiredOption('--key <key>', 'Tag key to remove')
    .option('--json', 'Output as JSON')
    .action(async options => {
      try {
        const result = await removeDefaultTag(options.key);
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          render(<Text color="green">Default tag removed: {options.key}</Text>);
        }
      } catch (err) {
        render(<Text color="red">{err instanceof Error ? err.message : String(err)}</Text>);
        process.exit(1);
      }
    });

  return tag;
};
