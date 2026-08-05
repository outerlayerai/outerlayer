"use client";

import { useState, useEffect } from "react";
import { useGitHubIdentity } from "../../../hooks/use-git-identity";
import { useSnackbar } from '@/components/snackbar';
import { useTranslate } from "@outerlayer/locales";
import { createSupabaseFontendClient } from "@/lib/adapters/supabase-frontend-client";
import { useRouter, useSearchParams } from "next/navigation";

import { ConnectionRow } from "./connection-row";

// ----------------------------------------------------------------------

const getTranslations = (key: string) => {
  return `dashboard.profileSettings.${key}`;
};

export default function GitHubAuthForm() {
  const { identity, refresh, removeIdentity } = useGitHubIdentity();
  const { enqueueSnackbar } = useSnackbar();
  const { t } = useTranslate();
  const [isConnecting, setIsConnecting] = useState(false);
  const router = useRouter();
  const searchParams = useSearchParams();

  const supabase = createSupabaseFontendClient();

  useEffect(() => {
    const provider = searchParams.get("provider");
    if (provider === "github") {
      refresh();

      const url = new URL(window.location.href);
      url.searchParams.delete("provider");
      url.searchParams.delete("next");
      router.replace(url.pathname);

      enqueueSnackbar(t(getTranslations("githubAuthSuccess")));
    }
  }, [searchParams, refresh, enqueueSnackbar, t, router]);

  const handleGitHubAuth = async () => {
    try {
      setIsConnecting(true);
      const { error } = await supabase.auth.linkIdentity({
        provider: "github",
        options: {
          redirectTo: `${window.location.origin}/auth/callback?next=/profile`,
          scopes: "read:user",
        },
      });

      if (error) throw error;
    } catch (error) {
      enqueueSnackbar((error as Error).message, {
        variant: "error",
      });
    } finally {
      setIsConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    try {
      // First unlink from Supabase Auth
      const { data: identities, error } =
        await supabase.auth.getUserIdentities();
      if (error) throw error;
      const githubIdentity = identities.identities.find(
        (i) => i.provider === "github"
      );
      if (githubIdentity) {
        await supabase.auth.unlinkIdentity(githubIdentity);
      }
      // Then remove from user_git_identity table
      await removeIdentity("github");
      enqueueSnackbar(t(getTranslations("githubDisconnectSuccess")));
    } catch (error) {
      enqueueSnackbar((error as Error).message, {
        variant: "error",
      });
    }
  };

  const githubUsername = identity?.username;

  return (
    <ConnectionRow
      icon="mdi:github"
      name="GitHub"
      connected={Boolean(githubUsername)}
      username={githubUsername}
      connectedLabel={t(getTranslations("connectedAs"))}
      notConnectedLabel="Not connected"
      connectLabel={
        isConnecting ? t(getTranslations("connecting")) : t(getTranslations("connectGitHub"))
      }
      disconnectLabel={t(getTranslations("disconnect"))}
      onConnect={handleGitHubAuth}
      onDisconnect={handleDisconnect}
      connecting={isConnecting}
    />
  );
}
