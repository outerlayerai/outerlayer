"use client";

import { useState } from "react";
import { Alert, Button, Card, Chip, Stack, Typography } from "@mui/material";
import { useTranslate } from "@outerlayer/locales";

import { decideOAuthConsentAction } from "../actions";
import type { ConsentDecision } from "../types";

type Props = {
  authorizationId: string;
  clientName: string;
  scopes: string[];
  resource: string | null;
};

export const OAuthConsentView = ({ authorizationId, clientName, scopes, resource }: Props) => {
  const { t } = useTranslate();
  const [pending, setPending] = useState<ConsentDecision | null>(null);
  const [error, setError] = useState<string | null>(null);

  const decide = async (decision: ConsentDecision) => {
    setPending(decision);
    setError(null);
    try {
      const resp = await decideOAuthConsentAction({ authorizationId, decision });
      if (!resp.ok) {
        throw new Error(resp.error.message);
      }
      // The redirect target is the connector's own redirect_uri (an
      // external origin) — a full browser navigation, not next/navigation's
      // client-side router.
      window.location.assign(resp.data.redirectUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unexpected error");
      setPending(null);
    }
  };

  return (
    <Card sx={{ p: 4, maxWidth: 480, mx: "auto", mt: 8 }}>
      <Stack spacing={3}>
        <Stack spacing={1}>
          <Typography variant="h5">{t("auth.oauthConsent.title")}</Typography>
          <Typography variant="body2" sx={{ color: "text.secondary" }}>
            {t("auth.oauthConsent.description", { clientName })}
          </Typography>
        </Stack>

        {resource && (
          <Stack spacing={0.5}>
            <Typography variant="caption" sx={{ color: "text.secondary" }}>
              {t("auth.oauthConsent.resourceLabel")}
            </Typography>
            <Typography variant="body2" sx={{ wordBreak: "break-all" }}>
              {resource}
            </Typography>
          </Stack>
        )}

        {scopes.length > 0 && (
          <Stack spacing={0.5}>
            <Typography variant="caption" sx={{ color: "text.secondary" }}>
              {t("auth.oauthConsent.scopesLabel")}
            </Typography>
            <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap" }}>
              {scopes.map((scope) => (
                <Chip key={scope} size="small" variant="outlined" label={scope} />
              ))}
            </Stack>
          </Stack>
        )}

        {error && <Alert severity="error">{error}</Alert>}

        <Stack direction="row" spacing={2} sx={{ justifyContent: "flex-end" }}>
          <Button
            variant="outlined"
            color="inherit"
            disabled={pending !== null}
            loading={pending === "deny"}
            onClick={() => decide("deny")}
          >
            {t("auth.oauthConsent.denyButton")}
          </Button>
          <Button
            variant="contained"
            disabled={pending !== null}
            loading={pending === "approve"}
            onClick={() => decide("approve")}
          >
            {t("auth.oauthConsent.approveButton")}
          </Button>
        </Stack>
      </Stack>
    </Card>
  );
};
