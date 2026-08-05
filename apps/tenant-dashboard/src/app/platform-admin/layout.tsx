import PlatformAdminGuard from '../../auth/guard/platform-admin-guard';
import { PlatformAdminTheme } from '../../sections/platform-admin/theme/platform-admin-theme';

type Props = {
  children: React.ReactNode;
};

export default async function PlatformAdminLayout({ children }: Props) {
  return (
    <PlatformAdminGuard>
      <PlatformAdminTheme>{children}</PlatformAdminTheme>
    </PlatformAdminGuard>
  );
}
