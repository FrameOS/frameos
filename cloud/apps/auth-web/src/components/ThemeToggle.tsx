"use client";

import { Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";

type Theme = "light" | "dark";
const themeCookieName = "frameos_theme";
const localStorageKey = "frameos-cloud-theme";

// Loopback names only — a LAN IP or a `.local` name is how you reach a real
// deployment from another device. Keep in step with app/layout.tsx's inline
// script, which makes the same call before first paint.
function isLocalHost() {
  const host = window.location.hostname.toLowerCase();
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "127.0.0.1" ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host === "[::1]"
  );
}

function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle("theme-dark", theme === "dark");
  const icon = document.querySelector("link[data-frameos-favicon]");
  icon?.setAttribute(
    "href",
    `/logo-${theme}${isLocalHost() ? "-mono" : ""}.svg`,
  );
}

function readThemeCookie() {
  const value = document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${themeCookieName}=`))
    ?.slice(themeCookieName.length + 1);
  return value === "dark" || value === "light" ? value : undefined;
}

function persistTheme(theme: Theme, cookieDomain?: string) {
  window.localStorage.setItem(localStorageKey, theme);
  document.cookie = [
    `${themeCookieName}=${theme}`,
    "Path=/",
    "Max-Age=31536000",
    "SameSite=Lax",
    ...(cookieDomain ? [`Domain=${cookieDomain}`, "Secure"] : []),
  ].join("; ");
}

export function ThemeToggle({
  cookieDomain,
}: {
  cookieDomain?: string | undefined;
}) {
  const [theme, setTheme] = useState<Theme>("light");

  useEffect(() => {
    const shared = readThemeCookie();
    const stored = window.localStorage.getItem(localStorageKey);
    const nextTheme =
      shared ??
      (stored === "dark" || stored === "light"
        ? stored
        : window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light");
    setTheme(nextTheme);
    applyTheme(nextTheme);
    persistTheme(nextTheme, cookieDomain);

    const syncSharedTheme = () => {
      const nextShared = readThemeCookie();
      if (nextShared) {
        setTheme(nextShared);
        applyTheme(nextShared);
        window.localStorage.setItem(localStorageKey, nextShared);
      }
    };
    const syncWhenVisible = () => {
      if (document.visibilityState === "visible") {
        syncSharedTheme();
      }
    };
    window.addEventListener("focus", syncSharedTheme);
    document.addEventListener("visibilitychange", syncWhenVisible);
    return () => {
      window.removeEventListener("focus", syncSharedTheme);
      document.removeEventListener("visibilitychange", syncWhenVisible);
    };
  }, [cookieDomain]);

  function toggleTheme() {
    const nextTheme = theme === "dark" ? "light" : "dark";
    setTheme(nextTheme);
    applyTheme(nextTheme);
    persistTheme(nextTheme, cookieDomain);
  }

  return (
    <button
      aria-label={theme === "dark" ? "Use light theme" : "Use dark theme"}
      className="theme-toggle"
      onClick={toggleTheme}
      title={theme === "dark" ? "Use light theme" : "Use dark theme"}
      type="button"
    >
      {theme === "dark" ? (
        <Sun aria-hidden size={18} />
      ) : (
        <Moon aria-hidden size={18} />
      )}
    </button>
  );
}
