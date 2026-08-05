"use client";

import { Stack } from "@mui/system";
import {
  Card,
  CardHeader,
  CardContent,
  CardActionArea,
  Divider,
  Box,
  Typography,
  Link,
} from "@mui/material";
import { useTranslate } from "@outerlayer/locales";
import { useCallback, useState } from "react";
import { useSnackbar } from "notistack";

import Iconify from "@/components/iconify";
import { fNumber } from "@/utils/format-number";
import { useCurrentUser, UserRoleEnum } from "@/lib/app-shell/use-current-user";
import { TIERS, type TierId } from "@/config/entitlements";

import { createPortalSession, upgradeSubscription, createCheckoutSession } from "../actions";
import { UpgradeConfirmationDialog } from "./upgrade-confirmation-dialog";

const UPGRADE_CARDS: Array<{
  tierId: TierId;
  icon: string;
  color: string;
}> = [
  { tierId: "growth", icon: "ph:lego-duotone", color: "primary.lighter" },
  { tierId: "team", icon: "ph:users-three-duotone", color: "warning.lighter" },
  { tierId: "enterprise", icon: "ic:outline-business", color: "secondary.lighter" },
];

type Props = {
  usage: number;
  storageGb: number;
  tierId: TierId;
  tierDisplayName: string;
  isCancelling: boolean;
};

export default function BillingManagement(props: Props) {
  const { t } = useTranslate();
  const { enqueueSnackbar } = useSnackbar();
  const { role } = useCurrentUser();

  const canManageBilling = role === UserRoleEnum.OWNER || role === UserRoleEnum.ADMIN;

  const manageBilling = useCallback(async () => {
    try {
      const result = await createPortalSession({ redirectTo: window.location.href });
      if (!result.ok) {
        enqueueSnackbar(result.error.message || "Failed to open billing portal", { variant: "error" });
        return;
      }
      window.location.assign(result.data);
    } catch {
      enqueueSnackbar("Failed to open billing portal", { variant: "error" });
    }
  }, [enqueueSnackbar]);

  const currentSortOrder = TIERS[props.tierId].sortOrder;
  const upgradeTiers = props.isCancelling
    ? UPGRADE_CARDS
    : UPGRADE_CARDS.filter(
        (card) => TIERS[card.tierId].sortOrder > currentSortOrder
      );

  const [pendingUpgrade, setPendingUpgrade] = useState<TierId | null>(null);
  const [upgradeLoading, setUpgradeLoading] = useState(false);

  const handleUpgradeClick = (tierId: TierId) => {
    if (!canManageBilling) return;

    if (tierId === "enterprise") {
      window.open("mailto:hello@outerlayer.ai?subject=OuterLayer%20Enterprise", "_blank");
      return;
    }

    setPendingUpgrade(tierId);
  };

  const handleUpgradeConfirm = async () => {
    if (!pendingUpgrade) return;

    setUpgradeLoading(true);
    try {
      const result = await upgradeSubscription({ tierId: pendingUpgrade });

      if (!result.ok) {
        if (result.error.message === 'subscription_canceled') {
          try {
            const checkoutResult = await createCheckoutSession({
              redirectTo: window.location.href,
              tierId: pendingUpgrade,
            });
            if (!checkoutResult.ok) {
              enqueueSnackbar(checkoutResult.error.message || "Failed to start checkout", { variant: "error" });
              return;
            }
            window.location.assign(checkoutResult.data);
            return;
          } catch {
            enqueueSnackbar(t("dashboard.settings.billing.management.subscriptionExpiredError"), { variant: "error" });
          }
          return;
        }
        enqueueSnackbar(result.error.message, { variant: "error" });
        return;
      }

      enqueueSnackbar(
        t("dashboard.settings.billing.management.upgradeSuccess"),
        { variant: "success" }
      );
      window.location.reload();
    } catch {
      enqueueSnackbar(t("dashboard.settings.billing.management.unexpectedError"), { variant: "error" });
    } finally {
      setUpgradeLoading(false);
      setPendingUpgrade(null);
    }
  };

  return (
    <Stack
      sx={{
        alignItems: "center",
        gap: 1
      }}>
      <Typography sx={{ textAlign: "center" }} variant="h4">
        {t("dashboard.settings.billing.management.plansHeading")}
      </Typography>
      <Typography sx={{ textAlign: "center" }}>
        {t("dashboard.settings.billing.management.plansSubheading")}
      </Typography>
      <Box
        sx={{
          width: "100%",
          my: 2
        }}>
        <Divider />
      </Box>
      <Stack
        direction="row"
        sx={{
          gap: 12,
          px: 6
        }}>
        <Stack>
          <Typography variant="h5">
            {t("dashboard.settings.billing.management.numRequests")}
          </Typography>
          <Typography variant="subtitle1">{fNumber(props.usage)}</Typography>
        </Stack>
        <Stack>
          <Typography variant="h5">
            {t("dashboard.settings.billing.management.storage")}
          </Typography>
          <Typography variant="subtitle1">{props.storageGb.toFixed(4)} GB</Typography>
        </Stack>
        <Stack>
          <Typography variant="h5">
            {t("dashboard.settings.billing.management.yourPlan")}
          </Typography>
          <Typography variant="subtitle1">
            {props.tierDisplayName}
          </Typography>
        </Stack>
        {canManageBilling && (
          <Stack>
            <Typography variant="h5">
              {t("dashboard.settings.billing.management.managePlanHeader")}
            </Typography>
            <Link
              component="button"
              variant="body2"
              aria-label="To manage your billing, click here to open in a new window."
              sx={{ textAlign: "left" }}
              onClick={manageBilling}
            >
              <Typography variant="subtitle1">
                {t("dashboard.settings.billing.management.managePlanLink")}
              </Typography>
            </Link>
          </Stack>
        )}
      </Stack>
      {canManageBilling && upgradeTiers.length > 0 && (
        <>
          <Box
            sx={{
              width: "100%",
              my: 2
            }}>
            <Divider />
          </Box>
          {props.isCancelling && (
            <Typography
              variant="body2"
              sx={{
                color: "warning.main",
                mb: 1
              }}>
              {t("dashboard.settings.billing.management.cancellationPending")}
            </Typography>
          )}
          <Typography variant="h6" sx={{ mb: 1 }}>
            {t("dashboard.settings.billing.management.upgradeHeading")}
          </Typography>
          <Stack direction="row" sx={{
            gap: 4
          }}>
            {upgradeTiers.map((card) => {
              const tierConfig = TIERS[card.tierId];
              return (
                <Box key={card.tierId} sx={{
                  width: 200
                }}>
                  <Card
                    sx={{ alignItems: "center", backgroundColor: card.color, textAlign: "center" }}
                    component={Stack}
                  >
                    <CardActionArea onClick={() => handleUpgradeClick(card.tierId)}>
                      <CardHeader
                        title={tierConfig.displayName}
                        subheader={tierConfig.pricing ?? t("dashboard.settings.billing.management.contactSales")}
                        sx={{ pt: 3, textAlign: "center" }}
                      />
                      <CardContent sx={{ px: 7, pt: 1 }}>
                        <Box sx={{
                          width: "100%"
                        }}>
                          <Iconify icon={card.icon} width={32} />
                        </Box>
                      </CardContent>
                    </CardActionArea>
                  </Card>
                </Box>
              );
            })}
          </Stack>
        </>
      )}
      <Typography variant="caption" sx={{
        mt: 8
      }}>
        {t("dashboard.settings.billing.rateLimitDisclaimer")}
      </Typography>
      {pendingUpgrade && (
        <UpgradeConfirmationDialog
          open={!!pendingUpgrade}
          onClose={() => setPendingUpgrade(null)}
          onConfirm={handleUpgradeConfirm}
          loading={upgradeLoading}
          currentTierName={props.tierDisplayName}
          newTierName={TIERS[pendingUpgrade].displayName}
          newTierPricing={TIERS[pendingUpgrade].pricing}
        />
      )}
    </Stack>
  );
}
