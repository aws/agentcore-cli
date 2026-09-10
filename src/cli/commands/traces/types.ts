export interface TracesListOptions {
  runtime?: string;
  limit?: string;
  since?: string;
  until?: string;
  json?: boolean;
}

export interface TracesGetOptions {
  runtime?: string;
  output?: string;
  since?: string;
  until?: string;
  json?: boolean;
}

export interface TracesCompareOptions {
  runtime?: string;
  since?: string;
  until?: string;
  json?: boolean;
}
