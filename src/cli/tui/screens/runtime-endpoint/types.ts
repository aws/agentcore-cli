export interface RuntimeEndpointWizardConfig {
  runtimeName: string;
  endpointName: string;
  version: number;
  description?: string;
}

export type RuntimeEndpointWizardStep = 'runtime' | 'endpoint' | 'confirm';
