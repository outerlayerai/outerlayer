import { describe, expect, it } from "vitest";
import { render } from "@react-email/render";
import { InviteEmail } from "./emails/invite-user";
import { ResetPasswordEmail } from "./emails/reset-password";
import { ConfirmSignupEmail } from "./emails/confirm-signup";
import { BuildFailureEmail } from "./emails/build-failure";
import { RoleChangedEmail } from "./emails/role-changed";
import { RemovedFromOrgEmail } from "./emails/removed-from-org";
import { TempAccessNotificationEmail } from "./emails/temp-access-notification";

function hrefs(html: string): string[] {
  // The renderer HTML-escapes attribute values (e.g. "&" -> "&amp;"), so decode
  // before comparing against the raw URL that was passed in as a prop.
  return [...html.matchAll(/href="([^"]*)"/g)].map((match) =>
    match[1]!.replaceAll("&amp;", "&"),
  );
}

describe("invite email", () => {
  // proves AC-081-01
  it("points the join button at the exact invite link", async () => {
    const inviteLink = "https://app.example.com/auth/accept-invite?id=abc123";
    const html = await render(
      <InviteEmail
        inviteLink={inviteLink}
        appUrl="https://app.example.com"
        companyName="Acme Inc"
      />,
    );

    expect(hrefs(html)).toEqual([inviteLink]);
  });

  // proves AC-081-05
  it("renders the invite sentence without a literal undefined when company name is omitted", async () => {
    const html = await render(
      <InviteEmail
        inviteLink="https://app.example.com/auth/accept-invite?id=abc123"
        appUrl="https://app.example.com"
      />,
    );

    expect(html).toContain("You have been invited to join");
    expect(html).not.toContain("undefined");
  });
});

describe("reset password email", () => {
  // proves AC-081-02
  it("points the reset button at the exact reset link", async () => {
    const resetPasswordLink = "https://app.example.com/auth/new-password?token=xyz";
    const html = await render(
      <ResetPasswordEmail
        resetPasswordLink={resetPasswordLink}
        appUrl="https://app.example.com"
      />,
    );

    expect(hrefs(html)).toEqual([resetPasswordLink]);
  });
});

describe("confirm signup email", () => {
  // proves AC-081-03
  it("points the confirm button at the exact confirm link", async () => {
    const confirmLink =
      "https://app.example.com/auth/confirm?token_hash=xyz&type=signup";
    const html = await render(
      <ConfirmSignupEmail confirmLink={confirmLink} appUrl="https://app.example.com" />,
    );

    expect(hrefs(html)).toEqual([confirmLink]);
  });
});

describe("build failure email", () => {
  const baseProps = {
    appUrl: "https://app.example.com",
    companyName: "Acme Inc",
    appName: "my-app",
    failureReason: "Build timed out",
    orgName: "acme",
  };

  // proves AC-081-04
  it("points both the button and the footer link at the exact dashboard URL", async () => {
    const html = await render(
      <BuildFailureEmail
        {...baseProps}
        commitMessage="fix bug"
        commitSha="abcdef1234567890"
        branchName="main"
      />,
    );

    const dashboardUrl = "https://app.example.com/orgs/acme/apps/my-app";
    expect(hrefs(html)).toEqual([dashboardUrl, dashboardUrl]);
  });

  // proves AC-081-06
  it("renders without a literal undefined when commit metadata is omitted", async () => {
    const html = await render(<BuildFailureEmail {...baseProps} />);

    expect(html).toContain("Build timed out");
    expect(html).not.toContain("undefined");
  });
});

describe("role changed email", () => {
  // proves AC-081-08
  it("renders the old role, new role, and org name as text", async () => {
    const html = await render(
      <RoleChangedEmail
        appUrl="https://app.example.com"
        orgName="Acme Inc"
        oldRole="member"
        newRole="admin"
      />,
    );

    expect(html).toContain("Acme Inc");
    expect(html).toContain("member");
    expect(html).toContain("admin");
  });
});

describe("removed from org email", () => {
  // proves AC-081-09
  it("renders the org name in both the preview and the body", async () => {
    const html = await render(
      <RemovedFromOrgEmail appUrl="https://app.example.com" orgName="Acme Inc" />,
    );

    const preview = html.match(/<div[^>]*style="display:none[^"]*"[^>]*>([^<]*)</)?.[1];
    expect(preview).toContain("Acme Inc");
    expect(html).toContain("You have been removed from Acme Inc");
  });
});

describe("temp access notification email", () => {
  // proves AC-081-10
  it("formats the expiry and renders the admin email and org name", async () => {
    const expiresAt = "2026-08-20T15:30:00.000Z";
    const html = await render(
      <TempAccessNotificationEmail
        appUrl="https://app.example.com"
        organizationName="Acme Inc"
        adminEmail="admin@agentmark.co"
        expiresAt={expiresAt}
      />,
    );

    expect(html).toContain("Acme Inc");
    expect(html).toContain("admin@agentmark.co");
    expect(html).not.toContain(expiresAt);
  });

  // proves AC-081-07
  it("omits the reason label when no reason is given", async () => {
    const html = await render(
      <TempAccessNotificationEmail
        appUrl="https://app.example.com"
        organizationName="Acme Inc"
        adminEmail="admin@agentmark.co"
        expiresAt="2026-08-20T15:30:00.000Z"
      />,
    );

    expect(html).not.toContain("Reason:");
    expect(html).not.toContain("undefined");
  });
});
