"use client";

import ForbiddenView from "../../sections/error/403-view";
import { LoadingScreen } from '@/components/loading-screen';
import { useAppContext } from "@/lib/app-shell/app-context";

type Props = {
  children: React.ReactNode;
};

export default function AppGuard({ children }: Props) {
  const { app, loading } = useAppContext();

  if (loading) {
    // AppGuard renders INSIDE the dashboard chrome (LayoutMain's flex
    // content pane), so the loader fills and centers within the visible content
    // area — LayoutMain already offsets the fixed header and reserves the rail.
    // No viewport-height override, which would overflow past the header.
    return <LoadingScreen />;
  }

  if (!app) {
    return <ForbiddenView />;
  }

  return children;
}
