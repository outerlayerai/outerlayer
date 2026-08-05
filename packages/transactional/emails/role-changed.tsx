import {
  Body,
  Container,
  Head,
  Html,
  Img,
  Preview,
  Section,
  Text,
} from "@react-email/components";
import * as React from "react";

export const RoleChangedEmail = ({
  appUrl,
  orgName,
  oldRole,
  newRole,
}: RoleChangedEmailProps) => {
  return (
    <Html>
      <Head />
      <Preview>Your role has been updated in {orgName}</Preview>
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
              Your role in {orgName} has been changed from <strong>{oldRole}</strong> to <strong>{newRole}</strong>.
            </Text>
            <Text style={text}>
              If you have any questions about this change, please contact your organization administrator.
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
};

interface RoleChangedEmailProps {
  appUrl: string;
  orgName: string;
  oldRole: string;
  newRole: string;
}

export default RoleChangedEmail;

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
