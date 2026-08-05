import NotFoundView from "../sections/error/not-found-view";

export const dynamic = 'force-dynamic';

export const metadata = {
  title: "404 Page Not Found!",
};

export default function NotFoundPage() {
  return <NotFoundView />;
}
