import { AcceptInviteView } from "@/features/auth";
import { Suspense } from "react";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Accept Invitation",
};

export default function AcceptInvitePage() {
  return (
    <Suspense>
      <AcceptInviteView />
    </Suspense>
  );
}
