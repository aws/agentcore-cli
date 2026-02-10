import type { MemoryStrategyType } from '../../../../schema';
import { MemoryStrategyTypeSchema } from '../../../../schema';

// ─────────────────────────────────────────────────────────────────────────────
// Memory Flow Types
// ─────────────────────────────────────────────────────────────────────────────

export type AddMemoryStep = 'name' | 'expiry' | 'strategies' | 'confirm';

export interface AddMemoryStrategyConfig {
  type: MemoryStrategyType;
}

export interface AddMemoryConfig {
  name: string;
  eventExpiryDuration: number;
  strategies: AddMemoryStrategyConfig[];
}

export const MEMORY_STEP_LABELS: Record<AddMemoryStep, string> = {
  name: 'Name',
  expiry: 'Expiry',
  strategies: 'Strategies',
  confirm: 'Confirm',
};

// ─────────────────────────────────────────────────────────────────────────────
// UI Option Constants (derived from schema)
// ─────────────────────────────────────────────────────────────────────────────

const STRATEGY_DESCRIPTIONS: Record<MemoryStrategyType, string> = {
  SEMANTIC: 'Vector-based semantic search over memories',
  SUMMARIZATION: 'Compress and summarize conversation context',
  USER_PREFERENCE: 'Track and recall user preferences',
};

export const MEMORY_STRATEGY_OPTIONS = MemoryStrategyTypeSchema.options.map(type => ({
  id: type,
  title: type.charAt(0) + type.slice(1).toLowerCase().replace(/_/g, ' '),
  description: STRATEGY_DESCRIPTIONS[type],
}));

export const EVENT_EXPIRY_OPTIONS = [
  { id: 7, title: '7 days', description: 'Minimum retention' },
  { id: 30, title: '30 days', description: 'One month' },
  { id: 90, title: '90 days', description: 'Three months' },
  { id: 180, title: '180 days', description: 'Six months' },
  { id: 365, title: '365 days', description: 'Maximum retention' },
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Defaults
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_EVENT_EXPIRY = 30;
