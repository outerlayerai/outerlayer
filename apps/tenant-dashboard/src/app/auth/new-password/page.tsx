import { NewPasswordView } from '@/features/auth';

// ----------------------------------------------------------------------

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'New Password',
};

export default function NewPasswordPage() {
  return <NewPasswordView />;
}
