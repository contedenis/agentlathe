export type ApprovalBroker = {
  ask(onRequest: (requestId: string) => void): Promise<boolean>;
  resolve(requestId: string, approved: boolean): boolean;
  rememberSession(sessionId: string, supportsElicitation: boolean): void;
  canElicit(sessionId: string): boolean;
};

// Assumes one process serves both the tools/call and the elicitation response.
export function createApprovalBroker(
  options: { timeoutMs?: number; maxSessions?: number } = {},
): ApprovalBroker {
  const { timeoutMs = 120_000, maxSessions = 500 } = options;
  const pending = new Map<string, (approved: boolean) => void>();
  const sessions = new Map<string, boolean>();

  const touch = (sessionId: string, value: boolean) => {
    sessions.delete(sessionId);
    sessions.set(sessionId, value);
  };

  return {
    ask(onRequest) {
      const requestId = crypto.randomUUID();
      return new Promise((settle) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          settle(false);
        }, timeoutMs);
        pending.set(requestId, (approved) => {
          clearTimeout(timer);
          pending.delete(requestId);
          settle(approved);
        });
        onRequest(requestId);
      });
    },

    resolve(requestId, approved) {
      const settle = pending.get(requestId);
      if (!settle) return false;
      settle(approved);
      return true;
    },

    rememberSession(sessionId, supportsElicitation) {
      if (!sessions.has(sessionId) && sessions.size >= maxSessions) {
        const oldest = sessions.keys().next().value;
        if (oldest !== undefined) sessions.delete(oldest);
      }
      touch(sessionId, supportsElicitation);
    },

    canElicit(sessionId) {
      const value = sessions.get(sessionId);
      if (value === undefined) return false;
      // LRU touch, not dead code: evicting an active session auto-denies later approvals.
      touch(sessionId, value);
      return value;
    },
  };
}

export const mcpApprovalBroker = createApprovalBroker();
