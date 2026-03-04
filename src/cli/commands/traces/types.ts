export interface TracesListOptions {
  agent?: string;
  limit?: string;
  since?: string;
  until?: string;
}

export interface TracesGetOptions {
  agent?: string;
  output?: string;
  since?: string;
  until?: string;
}
