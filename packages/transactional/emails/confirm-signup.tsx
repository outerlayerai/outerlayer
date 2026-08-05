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
  
  export const ConfirmSignupEmail = ({
    confirmLink = "",
    appUrl,
  }: ResetPasswordEmailProps) => {
    return (
      <Html>
        <Head />
        <Preview>Confirm Email</Preview>
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
                Thank you for signing up with agentmark.co! We are excited to have you join our community.
              </Text>
              <Text style={text}>
                To complete your registration, please confirm your email address by clicking the link below:
              </Text>
              <Section style={{ textAlign: "center" }}>
                <Button style={button} href={confirmLink}>
                  Confirm
                </Button>
              </Section>
            </Section>
          </Container>
        </Body>
      </Html>
    );
  };
  
  interface ResetPasswordEmailProps {
    confirmLink?: string;
    appUrl: string;
  }
  
  export default ConfirmSignupEmail;
  
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
  
  