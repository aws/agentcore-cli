import type { AgentCoreProjectSpec, HarnessSpec } from '../../../schema';
import { ValidationError } from '@/lib/errors/types';
import type { Result } from '@/lib/result';

const KEY_SEPARATOR = '::';

export function getSkillKey(skill: HarnessSpec['skills'][number]): string {
  if ('s3Uri' in skill) return `s3:${skill.s3Uri}`;
  if ('gitUrl' in skill) return `git:${skill.gitUrl}${skill.path ? `${KEY_SEPARATOR}${skill.path}` : ''}`;
  if ('awsSkills' in skill) return `awsSkills:${skill.awsSkills.paths?.slice().sort().join(',') ?? '*'}`;
  return `path:${skill.path}`;
}

export function buildGitSkillKey(gitUrl: string, gitPath?: string): string {
  return `git:${gitUrl}${gitPath ? `${KEY_SEPARATOR}${gitPath}` : ''}`;
}

export function validateGitSkillCredential(project: AgentCoreProjectSpec, credentialName: string): Result {
  const credential = project.credentials.find(c => c.name === credentialName);
  if (!credential) {
    return {
      success: false,
      error: new ValidationError(
        `Credential '${credentialName}' not found in project. Run 'agentcore add credential' first.`
      ),
    };
  }
  if (credential.authorizerType !== 'ApiKeyCredentialProvider') {
    return {
      success: false,
      error: new ValidationError(
        `Credential '${credentialName}' is type '${credential.authorizerType}'. Git skill auth requires an ApiKeyCredentialProvider credential.`
      ),
    };
  }
  return { success: true };
}
