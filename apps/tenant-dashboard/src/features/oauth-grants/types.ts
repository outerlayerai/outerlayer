export interface OAuthGrant {
  sessionId: string;
  clientId: string;
  clientName: string | null;
  scopes: string[];
  createdAt: string;
  refreshedAt: string | null;
}
