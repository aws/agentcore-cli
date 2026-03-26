/**
 * Global session registry for TUI test harness sessions.
 *
 * Tracks all active TuiSession instances and ensures they are cleaned up
 * on process exit or signal termination. Uses a module-level Map as the
 * singleton registry — no class needed.
 *
 * To avoid circular dependencies, this module defines a {@link ManagedSession}
 * interface that TuiSession (defined elsewhere) must implement. This module
 * never imports TuiSession directly.
 */
import type { CloseResult, SessionInfo } from './types.js';

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

/**
 * Interface for session objects managed by this registry.
 *
 * Avoids circular dependency with TuiSession (which imports session-manager).
 * TuiSession must implement this interface to be registered here.
 */
export interface ManagedSession {
  readonly sessionId: string;
  readonly info: SessionInfo;
  close(): Promise<CloseResult>;
}

// ---------------------------------------------------------------------------
// Module-level state (singleton registry)
// ---------------------------------------------------------------------------

const sessions = new Map<string, ManagedSession>();
let handlersRegistered = false;

// ---------------------------------------------------------------------------
// Process exit handlers
// ---------------------------------------------------------------------------

/**
 * Registers process signal handlers (once) so that all tracked sessions are
 * closed before the process terminates. The handlers are installed lazily on
 * the first call to {@link register}.
 *
 * - SIGTERM / SIGINT: async cleanup via {@link closeAll}, then exit 0.
 * - 'exit': synchronous — cannot await, so we just log a warning if sessions
 *   remain open. The OS will clean up child processes when the parent exits.
 */
function ensureProcessHandlers(): void {
  if (handlersRegistered) return;
  handlersRegistered = true;

  // Synchronous — cannot do async work here. If sessions are still open at
  // this point they were not cleaned up by SIGTERM/SIGINT handlers or by an
  // explicit closeAll() call. The OS will reap child processes automatically.
  process.on('exit', () => {
    if (sessions.size > 0) {
      // Best-effort warning; the process is already exiting.

      console.warn(
        `[tui-harness] ${sessions.size} session(s) still open at process exit. ` +
          'Child processes will be cleaned up by the OS.'
      );
    }
  });

  const handleSignal = async (): Promise<void> => {
    await closeAll();
    process.exit(0);
  };

  process.on('SIGTERM', () => {
    void handleSignal();
  });
  process.on('SIGINT', () => {
    void handleSignal();
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Register a session in the global registry.
 *
 * On the first registration, process signal handlers are installed to ensure
 * cleanup on SIGTERM and SIGINT.
 *
 * @param session - The session object to track. Must satisfy {@link ManagedSession}.
 */
export function register(session: ManagedSession): void {
  sessions.set(session.sessionId, session);
  ensureProcessHandlers();
}

/**
 * Remove a session from the global registry.
 *
 * This does **not** close the session — it simply stops tracking it. Callers
 * are responsible for calling `session.close()` separately if needed.
 *
 * @param sessionId - The unique identifier of the session to unregister.
 */
export function unregister(sessionId: string): void {
  sessions.delete(sessionId);
}

/**
 * Look up a session by its unique identifier.
 *
 * @param sessionId - The session ID to look up.
 * @returns The managed session, or undefined if no session with that ID is registered.
 */
export function get(sessionId: string): ManagedSession | undefined {
  return sessions.get(sessionId);
}

/**
 * Return metadata for all currently registered sessions.
 *
 * @returns An array of {@link SessionInfo} objects, one per registered session.
 */
export function listAll(): SessionInfo[] {
  return Array.from(sessions.values()).map(s => s.info);
}

/**
 * Close all registered sessions and clear the registry.
 *
 * Each session's `close()` method is called concurrently. Errors from
 * individual sessions are swallowed so that one failing session does not
 * prevent others from being cleaned up. The registry is cleared after all
 * close attempts have settled (whether resolved or rejected).
 *
 * This function is idempotent — calling it on an empty registry is a no-op.
 */
export async function closeAll(): Promise<void> {
  const promises = Array.from(sessions.values()).map(async session => {
    try {
      await session.close();
    } catch {
      // Best-effort cleanup — swallow errors from dead or already-closed sessions.
    }
  });

  await Promise.allSettled(promises);
  sessions.clear();
}
