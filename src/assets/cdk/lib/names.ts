export function toStackName(projectName: string, targetName: string): string {
  return `AgentCore-${projectName.replaceAll("_", "-")}-${targetName.replaceAll("_", "-")}`;
}
