import {
  CUSTOM_DOCKERFILE_NOTE_CATEGORY,
  PATH_SKILLS_COPIED_NOTE_CATEGORY,
  PATH_SKILLS_VERIFY_BASE_IMAGE_NOTE_CATEGORY,
} from '../constants';
import {
  buildCustomDockerfileNote,
  buildMissingDockerfileNote,
  buildPathSkillsCopiedNote,
  buildPathSkillsVerifyNote,
} from '../harness-action';
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

describe('buildPathSkillsCopiedNote', () => {
  it('lists the copied skill dirs and states no manual step is required', () => {
    const note = buildPathSkillsCopiedNote(['skills/greeting'], 'MyAgent');
    expect(note.category).toBe(PATH_SKILLS_COPIED_NOTE_CATEGORY);
    expect(note.message).toContain('"skills/greeting"');
    expect(note.message).toContain('app/MyAgent/');
    expect(note.message).toContain('no manual step');
  });

  it('pluralizes for multiple skills', () => {
    const note = buildPathSkillsCopiedNote(['skills/a', 'skills/b'], 'MyAgent');
    expect(note.message).toContain('directories were copied');
    expect(note.message).toContain('"skills/a"');
    expect(note.message).toContain('"skills/b"');
  });
});

describe('buildPathSkillsVerifyNote', () => {
  it('tells the user the path was not found and must exist in the image', () => {
    const note = buildPathSkillsVerifyNote(['skills/nonexistent'], 'MyAgent');
    expect(note.category).toBe(PATH_SKILLS_VERIFY_BASE_IMAGE_NOTE_CATEGORY);
    expect(note.message).toContain('"skills/nonexistent"');
    expect(note.message).toContain('NOT copied');
    expect(note.message).toMatch(/base image|Dockerfile COPY/);
  });
});
