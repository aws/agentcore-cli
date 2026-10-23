// CfnJson returns the components in Data.Value. Reserve 1 KiB of the 4 KiB
// response limit for the CloudFormation response envelope and identifiers.
// This is a conservative deployment budget, not a ConfigurationBundle API limit.
export const MAX_CONFIG_BUNDLE_DATA_BYTES = 3 * 1024;
