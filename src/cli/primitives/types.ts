import type { RemovalPreview } from '../operations/remove/types';
import type { ComponentType } from 'react';

export type { Result } from '../../lib/types';

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
export type { RemovalPreview };

/**
 * Screen component type for TUI add flows.
 */
export type AddScreenComponent = ComponentType<Record<string, unknown>> | null;
