/**
 * Common help text strings used across TUI screens.
 * Centralized here to ensure consistency and avoid repetition.
 * Style: abbreviated, use " · " separator, symbols like ↑↓ for arrows
 *
 * Key conventions:
 * - Esc: go back to previous screen / main menu
 * - Ctrl+C: exit the application entirely
 */
export const HELP_TEXT = {
  /** Standard exit hint (at top level where Esc exits the app) */
  EXIT: 'Esc back · Ctrl+C quit',
  /** Back to previous screen */
  BACK: 'Esc back · Ctrl+C quit',
  /** Navigation and selection */
  NAVIGATE_SELECT: '↑↓ navigate · Enter select · Esc back · Ctrl+C quit',
  /** Navigation with hotkeys */
  NAVIGATE_HOTKEYS: '↑↓ navigate · Enter select · hotkeys · Esc back · Ctrl+C quit',
  /** Retry after error */
  RETRY_EXIT: 'R retry · Esc back · Ctrl+C quit',
  /** Replan after complete or error */
  REPLAN_EXIT: 'P replan · Esc back · Ctrl+C quit',
  /** Deploy after successful plan */
  PLAN_DEPLOY: 'D deploy · Esc back · Ctrl+C quit',
  /** Confirm or cancel */
  CONFIRM_CANCEL: 'Enter confirm · Esc back · Ctrl+C quit',
  /** Y/N prompt */
  YES_NO: 'Enter/Y confirm · Esc/N cancel',
  /** Text input */
  TEXT_INPUT: 'Enter submit · Esc cancel',
  /** Multi-select list */
  MULTI_SELECT: '↑↓ navigate · Space toggle · Enter confirm · Esc back · Ctrl+C quit',
  /** Edit mode */
  EDIT_MODE: 'Esc back · Ctrl+C quit',
  /** Status screen refresh */
  STATUS_REFRESH: '↑↓ select · Enter refresh · Esc back · Ctrl+C quit',
  /** Status screen refresh with target cycling */
  STATUS_TARGET_CYCLE: '↑↓ select · Enter refresh · T target · Esc back · Ctrl+C quit',
  /** Variant config form */
  VARIANTS_FORM: 'Enter to select · Esc back',
} as const;

/**
 * CDK Bootstrap messaging used in init and deploy flows.
 */
export const BOOTSTRAP = {
  /** Title for bootstrap confirmation */
  TITLE: 'CDK bootstrapping required',
  /** Explanation of what bootstrapping does */
  EXPLAINER: `The AgentCore CLI uses AWS CDK and CloudFormation to manage AWS resources.
CDK bootstrapping is a one-time setup that creates resources CDK needs to deploy stacks.
This will create a CDKToolkit stack in your AWS account.`,
} as const;
