import type { Metadata } from "next";
import { cookies } from "next/headers";
import { PostHogProvider } from "../src/components/PostHogProvider";
import { ThemeToggle } from "../src/components/ThemeToggle";
import { getSessionCookieDomain } from "../src/lib/env";
import "./globals.css";

export const metadata: Metadata = {
  // Pages set their own title (their visible heading, verbatim — no site
  // suffix); the default only covers pages that don't.
  title: { default: "FrameOS Cloud", template: "%s" },
  description: "FrameOS Cloud account and backend linking prototype",
};

// Keep these in sync with src/components/ThemeToggle.tsx. They cannot be
// imported from it: it is a "use client" module, so a server component only
// ever sees client references for its exports, never the literal strings.
const themeCookieName = "frameos_theme";
const themeStorageKey = "frameos-cloud-theme";

// Runs synchronously in <head>, before the body paints, so a first-time
// visitor (no theme cookie yet) never sees a light flash. The precedence is
// deliberately identical to ThemeToggle's effect — cookie, then
// localStorage, then the system preference — so the pre-paint class and the
// class the effect applies always agree and the page never flips twice.
const themeScript = `(function(){try{
var c=document.cookie.split(";").map(function(p){return p.trim()}).filter(function(p){return p.indexOf("${themeCookieName}=")===0})[0];
var v=c?c.slice(${themeCookieName.length + 1}):null;
var t=(v==="dark"||v==="light")?v:null;
if(!t){var s=window.localStorage.getItem("${themeStorageKey}");
t=(s==="dark"||s==="light")?s:(window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light")}
document.documentElement.classList.toggle("theme-dark",t==="dark")}catch(e){}})()`;

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // Returning visitors get the right class straight out of the server render,
  // with no client JS at all. `suppressHydrationWarning` on <html> is what
  // lets the inline script below adjust the class without React complaining.
  const theme = (await cookies()).get(themeCookieName)?.value;

  return (
    <html
      className={theme === "dark" ? "theme-dark" : undefined}
      lang="en"
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <PostHogProvider>
          <ThemeToggle cookieDomain={getSessionCookieDomain()} />
          {children}
        </PostHogProvider>
      </body>
    </html>
  );
}
