import * as fs from 'fs';
import Handlebars from 'handlebars';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

const DOCKERFILE_PATH = path.resolve(__dirname, '..', 'container', 'python', 'Dockerfile');
const TS_DOCKERFILE_PATH = path.resolve(__dirname, '..', 'container', 'typescript', 'Dockerfile');

const ADOT_NODE_PRELOAD = '--require @aws/aws-distro-opentelemetry-node-autoinstrumentation/register';

describe('Dockerfile enableOtel rendering', () => {
  const template = Handlebars.compile(fs.readFileSync(DOCKERFILE_PATH, 'utf-8'));

  it('renders OS updates before switching to the runtime user', () => {
    const rendered = template({ entrypoint: 'main', enableOtel: true });
    expect(rendered).toContain('apt-get update');
    expect(rendered).toContain('apt-get upgrade -y');
    expect(rendered.indexOf('apt-get upgrade -y')).toBeLessThan(rendered.indexOf('USER bedrock_agentcore'));
  });

  it('disables uv caching before installing the locked dependencies', () => {
    const rendered = template({ entrypoint: 'main', enableOtel: true });
    expect(rendered).toContain('UV_NO_CACHE=1');
    expect(rendered.indexOf('UV_NO_CACHE=1')).toBeLessThan(rendered.indexOf('RUN uv sync --frozen'));
  });

  it('removes the global uv installation after the final sync and before changing users', () => {
    const rendered = template({ entrypoint: 'main', enableOtel: true });
    const uninstall = '/usr/local/bin/python -m pip uninstall -y uv';
    expect(rendered).toContain(uninstall);
    expect(rendered.lastIndexOf('uv sync --frozen')).toBeLessThan(rendered.indexOf(uninstall));
    expect(rendered.indexOf(uninstall)).toBeLessThan(rendered.indexOf('USER bedrock_agentcore'));
  });

  it('renders opentelemetry-instrument CMD when enableOtel is true', () => {
    const rendered = template({ entrypoint: 'main', enableOtel: true });
    expect(rendered).toMatchSnapshot('Dockerfile-enableOtel-true');
    expect(rendered).toContain('opentelemetry-instrument');
    expect(rendered).not.toContain('CMD ["python", "-m"');
  });

  it('renders plain python CMD when enableOtel is false', () => {
    const rendered = template({ entrypoint: 'main', enableOtel: false });
    expect(rendered).toMatchSnapshot('Dockerfile-enableOtel-false');
    expect(rendered).toContain('CMD ["python", "-m"');
    expect(rendered).not.toContain('opentelemetry-instrument');
  });
});

describe('TypeScript Dockerfile enableOtel rendering', () => {
  const template = Handlebars.compile(fs.readFileSync(TS_DOCKERFILE_PATH, 'utf-8'));

  it('preloads the ADOT Node distro when enableOtel is true', () => {
    const rendered = template({ entrypoint: 'main', enableOtel: true });
    expect(rendered).toMatchSnapshot('Dockerfile-ts-enableOtel-true');
    expect(rendered).toContain(ADOT_NODE_PRELOAD);
    // Node instruments via preload, never the Python console-script wrapper.
    // Asserted against the CMD line so the explanatory comment above it, which
    // names `opentelemetry-instrument`, does not trip this.
    expect(rendered).toContain('CMD ["npx", "tsx", "main.ts"]');
    expect(rendered).not.toMatch(/CMD \[[^\]]*opentelemetry-instrument/);
  });

  it('omits instrumentation when enableOtel is false', () => {
    const rendered = template({ entrypoint: 'main', enableOtel: false });
    expect(rendered).toMatchSnapshot('Dockerfile-ts-enableOtel-false');
    expect(rendered).not.toContain('NODE_OPTIONS');
    expect(rendered).not.toContain('aws-distro-opentelemetry');
    expect(rendered).toContain('CMD ["npx", "tsx", "main.ts"]');
  });
});
