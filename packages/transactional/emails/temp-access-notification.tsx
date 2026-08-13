import {
  Body,
  Container,
  Head,
  Html,
  Img,
  Preview,
  Section,
  Text,
} from '@react-email/components';

export interface TempAccessNotificationProps {
  appUrl: string;
  organizationName: string;
  adminEmail: string;
  expiresAt: string;
  reason?: string;
}

export const TempAccessNotificationEmail = ({
  appUrl = '',
  organizationName = 'Your Organization',
  adminEmail = 'admin@agentmark.co',
  expiresAt = '',
  reason,
}: TempAccessNotificationProps) => {
  const formattedExpiry = expiresAt
    ? new Date(expiresAt).toLocaleString('en-US', {
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    : '24 hours from now';

  return (
    <Html>
      <Head />
      <Preview>
        Platform admin access granted to {organizationName}
      </Preview>
      <Body style={main}>
        <Container style={container}>
          <Img
            src={`${appUrl}/figma/logo.png`}
            width="80"
            height="80"
            alt="Logo"
            style={{ margin: 'auto' }}
          />
          <Section>
            <Text style={heading}>Platform Admin Access Notification</Text>
            <Text style={text}>
              A platform administrator has been granted temporary read-only access to
              your organization <strong>{organizationName}</strong>.
            </Text>
            <Section style={infoBox}>
              <Text style={infoLabel}>Admin Email:</Text>
              <Text style={infoValue}>{adminEmail}</Text>
              <Text style={infoLabel}>Access Expires:</Text>
              <Text style={infoValue}>{formattedExpiry}</Text>
              {reason && (
                <>
                  <Text style={infoLabel}>Reason:</Text>
                  <Text style={infoValue}>{reason}</Text>
                </>
              )}
            </Section>
            <Text style={text}>
              This access is read-only and will be automatically revoked when it
              expires. If you have any concerns, please contact support.
            </Text>
            <Text style={footer}>
              This is an automated notification from agentmark.co.
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
};

export default TempAccessNotificationEmail;

const main = {
  backgroundColor: '#f6f9fc',
  padding: '10px 0',
};

const container = {
  backgroundColor: '#ffffff',
  border: '1px solid #f0f0f0',
  padding: '45px',
};

const heading = {
  fontFamily: "Helvetica, Arial, 'Lucida Grande', sans-serif",
  fontWeight: '600' as const,
  fontSize: '20px',
  color: '#1a1a1a',
  textAlign: 'center' as const,
  marginBottom: '20px',
};

const text = {
  fontFamily: "Helvetica, Arial, 'Lucida Grande', sans-serif",
  fontWeight: '300' as const,
  color: '#404040',
  lineHeight: '26px',
};

const infoBox = {
  backgroundColor: '#f8f9fa',
  borderRadius: '6px',
  padding: '16px 20px',
  margin: '20px 0',
};

const infoLabel = {
  fontFamily: "Helvetica, Arial, 'Lucida Grande', sans-serif",
  fontWeight: '600' as const,
  fontSize: '13px',
  color: '#666',
  marginBottom: '4px',
  marginTop: '12px',
};

const infoValue = {
  fontFamily: "Helvetica, Arial, 'Lucida Grande', sans-serif",
  fontWeight: '400' as const,
  fontSize: '15px',
  color: '#1a1a1a',
  marginTop: '0',
  marginBottom: '0',
};

const footer = {
  fontFamily: "Helvetica, Arial, 'Lucida Grande', sans-serif",
  fontWeight: '300' as const,
  fontSize: '12px',
  color: '#8898aa',
  marginTop: '30px',
  textAlign: 'center' as const,
};
