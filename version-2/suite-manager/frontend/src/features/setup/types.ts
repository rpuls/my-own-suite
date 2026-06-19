export type Owner = {
  createdAt: string;
  email: string;
  name: string;
};

export type SetupStatus = 'needs-owner' | 'signed-out' | 'signed-in';

export type SetupStatusResponse = {
  owner: Owner | null;
  status: SetupStatus;
};

export type SetupSessionState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'needs-owner'; error: string | null }
  | { kind: 'signed-out'; error: string | null; owner: Owner }
  | { kind: 'signed-in'; owner: Owner };
