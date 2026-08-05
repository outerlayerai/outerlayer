"use client";

import { z } from "zod";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import {
  uniqueNamesGenerator,
  Config,
  colors,
  names,
  languages,
} from "unique-names-generator";
import { useSnackbar } from "notistack";
import { useTranslate } from "@outerlayer/locales";

import { createOrganizationAction } from "./action-adapters";
import { paths } from "../../routes/paths";
import { useMemberships } from "@/lib/adapters/use-memberships";
import { useAuthContext } from "@/lib/adapters/use-auth-context";
import { fUniqueNameGenerator } from "../../utils/format-unique-name-generator";

// Same config as used elsewhere for consistency
const nameGeneratorConfig: Config = {
  dictionaries: [names, languages, colors],
  separator: "-",
  length: 3,
};

function generateOrgName(): string {
  return fUniqueNameGenerator(uniqueNamesGenerator(nameGeneratorConfig));
}

type FormValues = { companyName: string };

/**
 * Shared create-organization form logic, used by both the empty-state card and
 * the create-org dialog. The URL slug is generated silently at submit time —
 * only Company Name is user-facing — while the server contract stays unchanged
 * (both values are still submitted).
 */
export function useCreateOrg(options?: { onDone?: () => void }) {
  const router = useRouter();
  const { enqueueSnackbar } = useSnackbar();
  const { isAtOrgLimit } = useMemberships();
  const { refreshMemberships } = useAuthContext();
  const { t: translate } = useTranslate();

  const t = (key: string) => translate(`org.${key}`);

  const CreateOrgSchema = z.object({
    companyName: z
      .string()
      .min(1, t("validation.companyName.required"))
      .max(255, t("validation.companyName.max")),
  });

  const methods = useForm<FormValues>({
    resolver: zodResolver(CreateOrgSchema),
    defaultValues: { companyName: "" },
  });

  const onSubmit = methods.handleSubmit(async ({ companyName }) => {
    if (isAtOrgLimit) {
      enqueueSnackbar(t("orgLimitReached"), { variant: "error" });
      return;
    }

    const organizationName = generateOrgName();

    try {
      const result = await createOrganizationAction(organizationName, companyName);

      if (result.error) {
        enqueueSnackbar(result.error, { variant: "error" });
        return;
      }

      enqueueSnackbar(t("createSuccess"), { variant: "success" });

      await refreshMemberships();
      options?.onDone?.();

      if (result.data?.organizationName) {
        router.push(paths.orgs.org.apps.root(result.data.organizationName));
      }
    } catch (err) {
      console.error("Error creating organization:", err);
      enqueueSnackbar("Failed to create organization", { variant: "error" });
    }
  });

  return {
    methods,
    onSubmit,
    isSubmitting: methods.formState.isSubmitting,
    isAtOrgLimit,
    t,
  };
}
