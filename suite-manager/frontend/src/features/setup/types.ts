export type Owner = {
  createdAt: string;
  email: string;
  name: string;
};

export type SetupStatus = 'needs-owner' | 'signed-out' | 'signed-in';

export type TermsState = {
  accepted: boolean;
  acceptedAt: string | null;
  version: string;
};

// Owner-scoped Suite Manager preferences. Sent only in the signed-in status
// payload, so the first paint of every screen already knows them.
export type OwnerPreferences = {
  technicalControls: boolean;
};

export type SetupStatusResponse = {
  owner: Owner | null;
  ownerClaimRequired?: boolean;
  preferences?: OwnerPreferences;
  secureTransport?: boolean;
  status: SetupStatus;
  terms?: TermsState;
};

export type SetupSessionState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'needs-owner'; error: string | null; ownerClaimRequired: boolean }
  | { kind: 'signed-out'; error: string | null; owner: Owner }
  | { kind: 'signed-in'; owner: Owner; preferences: OwnerPreferences; terms: TermsState };
