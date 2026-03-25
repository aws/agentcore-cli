export type FetchResourceType = 'gateway' | 'agent';

export interface FetchAccessOptions {
  name?: string;
  type?: FetchResourceType;
  target?: string;
  json?: boolean;
}
