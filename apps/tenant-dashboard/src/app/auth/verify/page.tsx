import { VerifyView } from "@/features/auth";
import { Suspense } from "react";

// ----------------------------------------------------------------------

export const dynamic = 'force-dynamic';

export const metadata = {
  title: "Verify Email",
};

export default function VerifyPage() {
  return <Suspense>
    <VerifyView />
  </Suspense>;
}
