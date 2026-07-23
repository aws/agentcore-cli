import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

const ASSETS_DIR = path.resolve(__dirname, '..', 'python');
const EXPECTED_DEPENDENCIES = [
  ['http', '"aws-opentelemetry-distro >= 0.17.0"'],
  ['agui', '"aws-opentelemetry-distro >= 0.17.0"'],
  ['a2a', '"aws-opentelemetry-distro"'],
] as const;
const GCP_RESOURCE_DETECTOR_PIN = '"opentelemetry-resourcedetector-gcp == 1.12.0a0"';

describe('Google ADK observability dependencies', () => {
  it.each(EXPECTED_DEPENDENCIES)('%s uses the AWS OpenTelemetry distro', (protocol, expectedDependency) => {
    const pyproject = fs.readFileSync(
      path.join(ASSETS_DIR, protocol, 'googleadk', 'base', 'pyproject.toml'),
      'utf-8'
    );

    expect(pyproject).toContain(expectedDependency);
    expect(pyproject).not.toMatch(/^\s*"opentelemetry-distro",?$/m);
    expect(pyproject).not.toMatch(/^\s*"opentelemetry-exporter-otlp",?$/m);
  });

  it.each(EXPECTED_DEPENDENCIES)('%s pins the GCP resource detector to a usable wheel', protocol => {
    const pyproject = fs.readFileSync(
      path.join(ASSETS_DIR, protocol, 'googleadk', 'base', 'pyproject.toml'),
      'utf-8'
    );

    expect(pyproject).toContain(GCP_RESOURCE_DETECTOR_PIN);
  });
});
