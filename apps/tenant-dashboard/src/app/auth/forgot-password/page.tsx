import { ForgotPasswordView } from '@/features/auth';

// ----------------------------------------------------------------------

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Forgot Password',
};

export default function ForgotPasswordPage() {
  return <ForgotPasswordView />;
}
