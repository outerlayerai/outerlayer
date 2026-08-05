import {
  ConfirmSignupEmail,
  InviteEmail,
  ResetPasswordEmail,
  render,
} from "@repo/transactional";
import fs from "fs";
import { promisify } from "util";

const writeFile = promisify(fs.writeFile);
const mkdir = promisify(fs.mkdir);

async function generateTemplates() {
  const resetPasswordHtml = await render(
    ResetPasswordEmail({
      appUrl: "{{ .SiteURL }}",
      resetPasswordLink: "{{ .ConfirmationURL }}",
    }),
    { pretty: true }
  );

  const inviteUserHtml = await render(
    InviteEmail({
      appUrl: "{{ .SiteURL }}",
      inviteLink: "{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=invite&next=/auth/new-password",
      companyName: "{{ .Data.company_name }}"
    }),
    { pretty: true }
  );

  const confirmationHtml = await render(
    ConfirmSignupEmail({
      appUrl: "{{ .SiteURL }}",
      confirmLink: "{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email",
    }),
    { pretty: true }
  );

  const htmls = [
    { value: resetPasswordHtml, name: "password-reset" },
    {
      value: inviteUserHtml,
      name: "invite-user",
    },
    {
      value: confirmationHtml,
      name: "confirm-signup",
    },
  ];

  await mkdir("./supabase/templates", { recursive: true });

  await Promise.all(
    htmls.map(async (html) => {
      await writeFile(
        `./supabase/templates/${html.name}.html`,
        html.value
      );
      console.log(`The file ${html.name}.html was saved!`);
    })
  );

  console.log("Templates created!");
}

generateTemplates().catch((err) => {
  console.error("Error generating templates:", err);
  process.exit(1);
});
