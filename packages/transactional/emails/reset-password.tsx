import {
  Body,
  Button,
  Container,
  Head,
  Html,
  Img,
  Preview,
  Section,
  Text,
} from "@react-email/components";
import * as React from "react";

export const ResetPasswordEmail = ({
  resetPasswordLink = "",
  appUrl,
}: ResetPasswordEmailProps) => {
  return (
    <Html>
      <Head />
      <Preview>Reset your password</Preview>
      <Body style={main}>
        <Container style={container}>
          <Img
            src={`${appUrl}/figma/logo.png`}
            width="80"
            height="80"
            alt="Logo"
            style={{ margin: "auto" }}
          />
          <Section>
            <Text style={text}>Hi,</Text>
            <Text style={text}>
              Someone recently requested a password change for your agentmark.co
              account. If this was you, you can set a new password here:
            </Text>
            <Section style={{ textAlign: "center" }}>
              <Button style={button} href={resetPasswordLink}>
                Reset password
              </Button>
            </Section>
            <Text style={text}>
              If you don&apos;t want to change your password or didn&apos;t
              request this, just ignore and delete this message.
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
};

interface ResetPasswordEmailProps {
  resetPasswordLink?: string;
  appUrl: string;
}

export default ResetPasswordEmail;

const main = {
  backgroundColor: "#f6f9fc",
  padding: "10px 0",
};

const container = {
  backgroundColor: "#ffffff",
  border: "1px solid #f0f0f0",
  padding: "45px",
};

const text = {
  fontFamily: "Helvetica, Arial, 'Lucida Grande', sans-serif",
  fontWeight: "300",
  color: "#404040",
  lineHeight: "26px",
};

const button = {
  backgroundColor: "#007ee6",
  borderRadius: "4px",
  color: "#fff",
  fontFamily: "'Open Sans', 'Helvetica Neue', Arial",
  fontSize: "15px",
  textDecoration: "none",
  textAlign: "center" as const,
  display: "block",
  width: "210px",
  paddingTop: "15px",
  paddingBottom: "15px",
};

