export type FetchResourceType = 'gateway' | 'agent' | 'harness';

export interface FetchAccessOptions {
  name?: string;
  type?: FetchResourceType;
  target?: string;
  identityName?: string;
  json?: boolean;
}
