// Light and dark themes (§15.2): tokens in styles/tokens.css, switched with data-theme on
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

export function useToggleTheme() {
  const { data: me } = useMe();
  const update = useUpdatePreferences();
  return () => {
    const next: Theme = (me?.preferences.theme ?? "light") === "light" ? "dark" : "light";
    applyTheme(next);
    channel.post({ type: "theme", theme: next });
    update.mutate({ theme: next });
  };
}
