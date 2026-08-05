// Helper function to normalize email domain
function normalizeEmailDomain(email: string): string {
  const [localPart, domain] = email.split('@');
  if (!localPart || !domain) {
    throw new Error('Invalid email format');
  }

  const normalizedDomain = domain.toLowerCase();
  return `${localPart.toLowerCase()}@${normalizedDomain}`;
}

// Enhanced business email validation
export function validateBusinessEmail(email: string): { isValid: boolean; error?: string } {
  try {
    const normalizedEmail = normalizeEmailDomain(email.trim());
    const emailDomain = normalizedEmail.split('@')[1];

    if (!emailDomain) {
      return { isValid: false, error: 'Invalid email format' };
    }

    return { isValid: true };
  } catch {
    return { isValid: false, error: 'Invalid email format' };
  }
} 