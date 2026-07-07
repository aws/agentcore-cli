import { unwrapResult } from '../../../lib/result.js';
import { GLOBAL_CONFIG_FILE, readGlobalConfig } from '../../../lib/schemas/io/global-config.js';
import { resolveTelemetryPreference } from '../../telemetry/config.js';

export async function handleTelemetryStatus(configFile = GLOBAL_CONFIG_FILE): Promise<void> {
  const { config: globalConfig } = unwrapResult(await readGlobalConfig(configFile), { config: {} });
  const pref = await resolveTelemetryPreference(globalConfig);

  const status = pref.enabled ? 'Enabled' : 'Disabled';
  const sourceLabel =
    pref.source === 'environment'
      ? 'environment variable'
      : pref.source === 'global-config'
        ? `global config (${configFile})`
        : 'default';

  console.log(`Telemetry: ${status}`);
  console.log(`Source: ${sourceLabel}`);

  if (pref.envVar) {
    console.log(`\nNote: ${pref.envVar.name}=${pref.envVar.value} is set in your environment.`);
  }
}
