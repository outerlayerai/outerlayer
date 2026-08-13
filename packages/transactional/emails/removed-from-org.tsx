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

export const RemovedFromOrgEmail = ({
  appUrl,
  orgName,
}: RemovedFromOrgEmailProps) => {
  return (
    <Html>
      <Head />
      <Preview>You have been removed from {orgName}</Preview>
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
              You have been removed from {orgName}. You no longer have access to this organization.
            </Text>
            <Text style={text}>
              If you believe this was done in error, please contact your organization administrator.
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
};

interface RemovedFromOrgEmailProps {
  appUrl: string;
  orgName: string;
}

export default RemovedFromOrgEmail;

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
