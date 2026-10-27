// Light, dark and blue-grey themes (§15.2; blue-grey from team trial round 6): tokens in styles/tokens.css, switched with data-theme on
// <html>. The choice is a user preference saved through PATCH /me/preferences.
import { useEffect } from "react";
import type { Theme } from "@sms/contract";
import { useMe, useUpdatePreferences } from "../api/hooks";
import { channel } from "./channel";

export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
}

/** Applies the user's theme and follows changes made in other windows. */
export function useThemeSync() {
  const { data: me } = useMe();
  const theme = me?.preferences.theme;
  useEffect(() => {
    if (theme) applyTheme(theme);
  }, [theme]);
  useEffect(() => channel.on((m) => m.type === "theme" && applyTheme(m.theme)), []);
}

export const THEMES: { value: Theme; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "bluegrey", label: "Blue-grey" },
];

/** Switches to `next` here, in the other windows, and in the user's preferences. */
export function useSetTheme() {
  const update = useUpdatePreferences();
  return (next: Theme) => {
    applyTheme(next);
    channel.post({ type: "theme", theme: next });
    update.mutate({ theme: next });
  };
}
