/**
 * MaterialIcon — thin wrapper around @expo/vector-icons MaterialIcons.
 *
 * Maps Stitch design icon names (Material Symbols Outlined) to the equivalent
 * MaterialIcons glyph in @expo/vector-icons. Names that exist in both ship
 * through unchanged; outliers get aliased.
 *
 * Usage: <MaterialIcon name="radar" size={18} color={P.primaryContainer} />
 */
import React from "react";
import { MaterialIcons } from "@expo/vector-icons";

type StitchIconName =
  | "menu"
  | "notifications"
  | "notifications_active"
  | "more_vert"
  | "settings"
  | "radar"
  | "monitoring"
  | "swap_horiz"
  | "account_balance_wallet"
  | "person"
  | "currency_exchange"
  | "currency_bitcoin"
  | "trending_up"
  | "trending_down"
  | "north_east"
  | "south_east"
  | "check_circle"
  | "warning"
  | "info"
  | "water_drop"
  | "waves"
  | "done"
  | "chevron_right"
  | "add"
  | "remove"
  | "fullscreen"
  | "sentiment_neutral"
  | "gpp_maybe"
  | "analytics"
  | "history"
  | "auto_graph"
  | "bolt"
  | "lock"
  | "track_changes"
  | "location_on"
  | "list_alt";

// Map Stitch names → @expo/vector-icons MaterialIcons names.
// MaterialIcons uses snake_case same as Material Symbols for most icons,
// but a few need aliasing (the types below narrow what's actually available).
const ICON_MAP: Record<StitchIconName, React.ComponentProps<typeof MaterialIcons>["name"]> = {
  menu: "menu",
  notifications: "notifications",
  notifications_active: "notifications-active",
  more_vert: "more-vert",
  settings: "settings",
  radar: "radar",
  monitoring: "monitor-heart",
  swap_horiz: "swap-horiz",
  account_balance_wallet: "account-balance-wallet",
  person: "person",
  currency_exchange: "currency-exchange",
  currency_bitcoin: "currency-bitcoin",
  trending_up: "trending-up",
  trending_down: "trending-down",
  north_east: "north-east",
  south_east: "south-east",
  check_circle: "check-circle",
  warning: "warning",
  info: "info",
  water_drop: "water-drop",
  waves: "waves",
  done: "done",
  chevron_right: "chevron-right",
  add: "add",
  remove: "remove",
  fullscreen: "fullscreen",
  sentiment_neutral: "sentiment-neutral",
  gpp_maybe: "gpp-maybe",
  analytics: "analytics",
  history: "history",
  auto_graph: "auto-graph",
  bolt: "bolt",
  lock: "lock",
  track_changes: "track-changes",
  location_on: "location-on",
  list_alt: "list-alt",
};

export function MaterialIcon({
  name,
  size = 20,
  color,
  style,
}: {
  name: StitchIconName;
  size?: number;
  color?: string;
  style?: React.ComponentProps<typeof MaterialIcons>["style"];
}) {
  const mapped = ICON_MAP[name];
  return <MaterialIcons name={mapped} size={size} color={color} style={style} />;
}
