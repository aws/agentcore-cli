import { GLOBAL_CONFIG_DIR, GLOBAL_CONFIG_FILE, updateGlobalConfig } from '../../../lib/schemas/io/global-config.js';
import { resolveTelemetryPreference } from '../../telemetry/config.js';

export async function handleTelemetryDisable(
  configDir = GLOBAL_CONFIG_DIR,
  configFile = GLOBAL_CONFIG_FILE
): Promise<boolean> {
  const ok = await updateGlobalConfig({ telemetry: { enabled: false } }, configDir, configFile);
  console.log(ok ? 'Telemetry has been disabled.' : `Warning: could not write config to ${configFile}`);
  return ok;
}

export async function handleTelemetryEnable(
  configDir = GLOBAL_CONFIG_DIR,
  configFile = GLOBAL_CONFIG_FILE
): Promise<boolean> {
  const ok = await updateGlobalConfig({ telemetry: { enabled: true } }, configDir, configFile);
  console.log(ok ? 'Telemetry has been enabled.' : `Warning: could not write config to ${configFile}`);
  return ok;
}

export async function handleTelemetryStatus(configFile = GLOBAL_CONFIG_FILE): Promise<void> {
  const pref = await resolveTelemetryPreference(configFile);

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
