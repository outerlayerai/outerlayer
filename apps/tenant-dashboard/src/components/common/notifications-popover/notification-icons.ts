// Maps a notification's `type` to a line-glyph. The column is nullable TEXT and
// producers today only emit "warning", so the default branch is the common real
// case — it must return a valid glyph for null / undefined / unknown types, not
// throw or yield undefined (which would render a broken icon). The other keys are
// forward-compat for future producers (deploy / billing / alert / info).

const DEFAULT_ICON = "mdi:bell-outline";

const NOTIFICATION_ICONS: Record<string, string> = {
  warning: "mdi:alert-outline",
  alert: "mdi:alert-outline",
  deploy: "mdi:rocket-launch-outline",
  billing: "mdi:credit-card-outline",
  info: "mdi:information-outline",
};

export function iconForNotificationType(type: string | null | undefined): string {
  return (type && NOTIFICATION_ICONS[type.toLowerCase()]) || DEFAULT_ICON;
}
