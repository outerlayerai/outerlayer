import {
  Body,
  Button,
  Container,
  Head,
  Html,
  Img,
  Link,
  Preview,
  Section,
  Text,
} from "@react-email/components";
import * as React from "react";

export const BuildFailureEmail = ({
  appUrl,
  companyName,
  appName,
  failureReason,
  commitMessage,
  commitSha,
  branchName,
  orgName,
}: BuildFailureEmailProps) => {
  const dashboardUrl = `${appUrl}/orgs/${orgName}/apps/${appName}`;
  
  return (
    <Html>
      <Head />
      <Preview>Build failed for {appName}</Preview>
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
            <Text style={heading}>Build Failed</Text>
            <Text style={text}>
              Hi there,
            </Text>
            <Text style={text}>
              The build for your app <strong>{appName}</strong> in {companyName} has failed.
            </Text>
            
            <Section style={detailsContainer}>
              <Text style={detailsHeading}>Failure Details:</Text>
              <Text style={detailText}><strong>App:</strong> {appName}</Text>
              <Text style={detailText}><strong>Branch:</strong> {branchName}</Text>
              <Text style={detailText}><strong>Commit:</strong> {commitSha?.substring(0, 8)}</Text>
              <Text style={detailText}><strong>Commit Message:</strong> {commitMessage}</Text>
              <Text style={detailText}><strong>Error:</strong> {failureReason}</Text>
            </Section>
            
            <Section style={{ textAlign: "center", marginTop: "32px" }}>
              <Button style={button} href={dashboardUrl}>
                View in Dashboard
              </Button>
            </Section>
            
            <Text style={footerText}>
              You can view more details and troubleshoot the issue in your{" "}
              <Link style={anchor} href={dashboardUrl}>
                dashboard
              </Link>.
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
};

interface BuildFailureEmailProps {
  appUrl: string;
  companyName: string;
  appName: string;
  failureReason: string;
  commitMessage?: string;
  commitSha?: string;
  branchName?: string;
  orgName: string;
}

export default BuildFailureEmail;

const main = {
  backgroundColor: "#f6f9fc",
  padding: "10px 0",
};

const container = {
  backgroundColor: "#ffffff",
  border: "1px solid #f0f0f0",
  padding: "45px",
};

const heading = {
  fontFamily: "Helvetica, Arial, 'Lucida Grande', sans-serif",
  fontSize: "24px",
  fontWeight: "600",
  color: "#e53e3e",
  lineHeight: "32px",
  marginBottom: "16px",
};

const text = {
  fontFamily: "Helvetica, Arial, 'Lucida Grande', sans-serif",
  fontWeight: "300",
  color: "#404040",
  lineHeight: "26px",
};

const detailsContainer = {
  backgroundColor: "#f8f9fa",
  border: "1px solid #e2e8f0",
  borderRadius: "6px",
  padding: "20px",
  margin: "20px 0",
};

const detailsHeading = {
  fontFamily: "Helvetica, Arial, 'Lucida Grande', sans-serif",
  fontSize: "16px",
  fontWeight: "600",
  color: "#2d3748",
  marginBottom: "12px",
};

const detailText = {
  fontFamily: "Helvetica, Arial, 'Lucida Grande', sans-serif",
  fontSize: "14px",
  color: "#4a5568",
  lineHeight: "20px",
  margin: "4px 0",
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

const footerText = {
  fontFamily: "Helvetica, Arial, 'Lucida Grande', sans-serif",
  fontSize: "14px",
  color: "#6b7280",
  lineHeight: "20px",
  marginTop: "24px",
};

const anchor = {
  textDecoration: "underline",
  color: "#007ee6",
};