import { CUSTOM_DOCKERFILE_NOTE_CATEGORY } from '../constants';
import { buildCustomDockerfileNote, buildMissingDockerfileNote } from '../harness-action';
import { describe, expect, it } from 'vitest';

// ============================================================================
// Custom-Dockerfile export note
// ============================================================================

describe('buildCustomDockerfileNote', () => {
  it('uses the custom-dockerfile category so EXPORT_NOTES is no longer empty', () => {
    const note = buildCustomDockerfileNote('Harness.Dockerfile', 'MyHarnessAgent');
    expect(note.category).toBe(CUSTOM_DOCKERFILE_NOTE_CATEGORY);
  });

  it('references the actual dockerfile name and target agent path', () => {
    const note = buildCustomDockerfileNote('Harness.Dockerfile', 'MyHarnessAgent');
    expect(note.message).toContain('Harness.Dockerfile');
    expect(note.message).toContain('app/MyHarnessAgent/Harness.Dockerfile');
  });

  it('warns that the agent will not run as-is and provides the agent build layer', () => {
    const note = buildCustomDockerfileNote('Custom.Dockerfile', 'AgentX');
    expect(note.message).toMatch(/will NOT run as-is/);
    // The appended build layer must install deps, copy code, and set a startup command.
    expect(note.message).toContain('uv sync --frozen --no-dev');
    expect(note.message).toContain('COPY --chown=bedrock_agentcore:bedrock_agentcore . .');
    expect(note.message).toContain('CMD ["opentelemetry-instrument", "python", "-m", "main"]');
  });
});

// ============================================================================
// Missing-Dockerfile export note
// ============================================================================

describe('buildMissingDockerfileNote', () => {
  it('explains the referenced dockerfile is absent and where to create it', () => {
    const note = buildMissingDockerfileNote('Harness.Dockerfile', 'MyHarness', 'MyHarnessAgent');
    expect(note.category).toMatch(/Dockerfile not found/);
    expect(note.message).toContain('app/MyHarness/');
    expect(note.message).toContain('app/MyHarnessAgent/Harness.Dockerfile');
  });
});
