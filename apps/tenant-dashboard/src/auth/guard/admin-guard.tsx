import ForbiddenView from "../../sections/error/403-view";
import { useAuthContext } from "../hooks";

type Props = {
  children: React.ReactNode;
};

export default function AdminGuard({ children }: Props) {
  const { user } = useAuthContext();
  if (user?.role !== "admin" && user?.role !== "owner") {
    return <ForbiddenView />;
  }
  return children;
}
