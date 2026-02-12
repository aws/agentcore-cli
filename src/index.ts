/**
 * Main entry point for the agentcore package.
 * Exports public APIs from schema and lib modules.
 *
 * For CDK constructs, use @aws/agentcore-cdk package.
 */

// Schema exports (types, constants, errors)
export * from './schema';

// Lib exports (utilities, packaging, config I/O)
export * from './lib';
