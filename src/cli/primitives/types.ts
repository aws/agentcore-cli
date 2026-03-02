import type { RemovalPreview, RemovalResult } from '../operations/remove/types';
import type { ComponentType } from 'react';

/**
 * Result of an add operation.
 * Use the generic parameter to type extra fields on the success branch:
 *   AddResult<{ agentName: string }> → success branch has typed agentName
 */
export type AddResult<T extends Record<string, unknown> = Record<string, unknown>> =
  | ({ success: true; message?: string } & T)
  | { success: false; error: string };

/**
 * Represents a resource that can be removed.
 */
export interface RemovableResource {
  name: string;
  [key: string]: unknown;
}

/**
 * Re-export removal types from shared types.
 */
export type { RemovalPreview, RemovalResult };

/**
 * Screen component type for TUI add flows.
 */
export type AddScreenComponent = ComponentType<Record<string, unknown>> | null;
