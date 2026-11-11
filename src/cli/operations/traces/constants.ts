/** Shared CloudWatch log group holding OTel spans for all runtimes in a region. */
export const SPANS_LOG_GROUP = 'aws/spans';

export const TRACE_ID_PATTERN = /^[a-fA-F0-9-]+$/;
