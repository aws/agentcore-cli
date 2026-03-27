export interface TracesListOptions {
  runtime?: string;
  limit?: string;
  since?: string;
  until?: string;
}

export interface TracesGetOptions {
  runtime?: string;
  output?: string;
  since?: string;
  until?: string;
}
