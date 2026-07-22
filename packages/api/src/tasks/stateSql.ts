import { ACTIVE_TASK_STATES, TERMINAL_TASK_STATES } from '@workspace/sdk';

/**
 * SQL literal lists derived from the shared state vocabulary. SQL cannot import TypeScript, so
 * without these the state names would be hardcoded in every query — the exact duplication that lets
 * a new state be added in code while queries silently ignore it.
 */
export const ACTIVE_STATES_SQL = ACTIVE_TASK_STATES.map((s) => `'${s}'`).join(', ');
export const TERMINAL_STATES_SQL = TERMINAL_TASK_STATES.map((s) => `'${s}'`).join(', ');
