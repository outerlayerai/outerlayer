"use client";

import { Stack } from "@mui/system";
import {
  Card,
  CardHeader,
  CardContent,
  Divider,
  Box,
  CardActionArea,
  Typography,
} from "@mui/material";
import { useTranslate } from "@outerlayer/locales";
import { useSearchParams } from "next/navigation";
import { enqueueSnackbar } from "notistack";

import Iconify from "@/components/iconify";
import { fNumber } from "@/utils/format-number";
import { useCurrentUser, UserRoleEnum } from "@/lib/app-shell/use-current-user";

import { createCheckoutSession } from "../actions";
import type { TierId } from "@/config/entitlements";

export default function BillingSetup({ usage, storageGb }: { usage: number; storageGb: number }) {
  const { t } = useTranslate();
  const { role } = useCurrentUser();
  const searchParams = useSearchParams();

  const canAddBilling = role === UserRoleEnum.OWNER || role === UserRoleEnum.ADMIN;

  const billingSignup = async (tierId: TierId) => {
    if (!canAddBilling) return;
    const returnTo = searchParams.get("returnTo");
    const redirectUrl = returnTo
      ? `${window.location.origin}${returnTo}`
      : window.location.href;
    try {
      const result = await createCheckoutSession({ redirectTo: redirectUrl, tierId });
      if (!result.ok) {
        enqueueSnackbar(result.error.message || "Failed to start checkout", { variant: "error" });
        return;
      }
      window.location.assign(result.data);
    } catch {
      enqueueSnackbar("Failed to start checkout", { variant: "error" });
    }
  };

  const enterpriseChat = () => {
    if (!canAddBilling) return;
    window.open("mailto:hello@outerlayer.ai?subject=OuterLayer%20Enterprise", "_blank");
  };

  return (
    <Stack
      sx={{
        alignItems: "center",
        gap: 1
      }}>
      <Typography sx={{ textAlign: "center" }} variant="h4">
        {t("dashboard.settings.billing.setup.plansHeading")}
      </Typography>
      <Typography sx={{ textAlign: "center" }}>
        {t("dashboard.settings.billing.setup.plansSubheading")}
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
          gap: 4,
          px: 6
        }}>
        <Box sx={{
          width: 200
        }}>
          <Card
            sx={{ alignItems: "center", backgroundColor: "primary.lighter", textAlign: "center" }}
            component={Stack}
          >
            <CardActionArea onClick={() => billingSignup('growth')}>
              <CardHeader
                title={t("dashboard.settings.billing.setup.standardPlan")}
                sx={{ pt: 3, textAlign: "center" }}
              />
              <CardContent sx={{ px: 7, pt: 2 }}>
                <Box sx={{
                  width: "100%"
                }}>
                  <Iconify icon="ph:lego-duotone" width={32} />
                </Box>
              </CardContent>
            </CardActionArea>
          </Card>
          <Typography variant="caption">
            {t("dashboard.settings.billing.setup.standardPlanDescription")}
          </Typography>
        </Box>
        <Box sx={{
          width: 200
        }}>
          <Card
            sx={{ alignItems: "center", backgroundColor: "warning.lighter", textAlign: "center" }}
            component={Stack}
          >
            <CardActionArea onClick={() => billingSignup('team')}>
              <CardHeader
                title={t("dashboard.settings.billing.setup.teamPlan")}
                sx={{ pt: 3, textAlign: "center" }}
              />
              <CardContent sx={{ px: 7, pt: 2 }}>
                <Box sx={{
                  width: "100%"
                }}>
                  <Iconify icon="ph:users-three-duotone" width={32} />
                </Box>
              </CardContent>
            </CardActionArea>
          </Card>
          <Typography variant="caption">
            {t("dashboard.settings.billing.setup.teamPlanDescription")}
          </Typography>
        </Box>
        <Box sx={{
          width: 200
        }}>
          <Card
            sx={{ alignItems: "center", backgroundColor: "secondary.lighter", textAlign: "center" }}
            component={Stack}
          >
            <CardActionArea onClick={enterpriseChat}>
              <CardHeader
                title={t("dashboard.settings.billing.setup.enterprisePlan")}
                sx={{ pt: 3, textAlign: "center" }}
              />
              <CardContent sx={{ px: 8, pt: 2 }}>
                <Box sx={{
                  width: "100%"
                }}>
                  <Iconify icon="ic:outline-business" width={32} />
                </Box>
              </CardContent>
            </CardActionArea>
          </Card>
          <Typography variant="caption" sx={{
            maxWidth: "100px"
          }}>
            {t("dashboard.settings.billing.setup.enterprisePlanDescription")}
          </Typography>
        </Box>
      </Stack>
      <Stack
        direction="row"
        sx={{
          mt: 2,
          width: 420,
          gap: 4
        }}>
        <Stack
          direction="row"
          sx={{
            alignItems: "center",
            gap: 2
          }}>
          <Typography variant="subtitle1" sx={{
            fontWeight: 700
          }}>
            {t("dashboard.settings.billing.setup.yourPlan")}
          </Typography>
          <Typography variant="subtitle1">
            {t("dashboard.settings.billing.setup.hobbyPlan")}
          </Typography>
          <Stack
            direction="row"
            sx={{
              alignItems: "center",
              gap: 2
            }}>
            <Typography variant="subtitle1" sx={{
              fontWeight: 700
            }}>
              {t("dashboard.settings.billing.setup.numRequests")}
            </Typography>
            <Typography variant="subtitle1">{fNumber(usage)}</Typography>
          </Stack>
          <Stack
            direction="row"
            sx={{
              alignItems: "center",
              gap: 2
            }}>
            <Typography variant="subtitle1" sx={{
              fontWeight: 700
            }}>
              {t("dashboard.settings.billing.setup.storage")}
            </Typography>
            <Typography variant="subtitle1">{storageGb.toFixed(4)} GB</Typography>
          </Stack>
        </Stack>
      </Stack>
      <Typography variant="caption" sx={{
        mt: 8
      }}>
        {t("dashboard.settings.billing.rateLimitDisclaimer")}
      </Typography>
    </Stack>
  );
}
