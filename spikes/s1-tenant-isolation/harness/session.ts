// Mock session store standing in for Better Auth (S2 covers real sessions).
// The org id comes from the server-side session record, never from the request.
export interface Session {
  readonly userId: string;
  readonly activeOrgId: string;
}

const sessions = new Map<string, Session>();

export function createSession(token: string, session: Session): void {
  sessions.set(token, session);
}

export function getSession(token: string | undefined): Session | null {
  return token ? (sessions.get(token) ?? null) : null;
}
