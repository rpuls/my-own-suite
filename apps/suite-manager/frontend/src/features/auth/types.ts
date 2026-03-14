export type AuthenticatedOwner = {
  email: string;
  name: string;
};

export type SessionState =
  | { kind: 'loading' }
  | { kind: 'authenticated'; owner: AuthenticatedOwner }
  | { kind: 'unauthenticated'; error: string | null }
  | { kind: 'error'; message: string };

