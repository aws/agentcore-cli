export const MCP_DEFAULT_PORT = 8000;
export const A2A_DEFAULT_PORT = 9000;

/**
 * Protocol-scoped port override read by the SDK's `serve_a2a()`. The generic
 * `PORT` is not used for A2A: shared images set it to another protocol's port
 * (8080 for HTTP, 8000 for MCP), which would bind the A2A server off-contract.
 */
export const A2A_PORT_ENV = 'A2A_PORT';
