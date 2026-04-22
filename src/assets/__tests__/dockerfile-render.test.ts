import * as fs from 'fs';
import Handlebars from 'handlebars';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

const DOCKERFILE_PATH = path.resolve(__dirname, '..', 'container', 'python', 'Dockerfile');

describe('Dockerfile enableOtel rendering', () => {
  const template = Handlebars.compile(fs.readFileSync(DOCKERFILE_PATH, 'utf-8'));

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
