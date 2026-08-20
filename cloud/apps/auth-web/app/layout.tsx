import type { Metadata } from "next";
import { cookies } from "next/headers";
import { AnalyticsConsentBanner } from "../src/components/AnalyticsConsent";
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
//
// It also picks the favicon, which is four files rather than two: whether the
// page is served from a loopback name chooses whether the three squares keep
// their colours, and prefers-color-scheme chooses the outline colour. Anyone
// working on the cloud has a dev tab and the real account.frameos.net open at
// once; the monochrome icon is what tells them apart in the tab strip. The
// workspace SPA applies the same rule to its own icon — see
// frontend/src/utils/frameosTheme.ts and cloud-frontend/src/index.html.
//
// The icon deliberately ignores `t`, the theme resolved just above. It is
// painted into the tab strip rather than the page, so the only thing it has
// to contrast with is the browser chrome — and a dark Chrome showing a
// light-themed account page was drawing the black glyph onto a dark strip,
// where it all but disappeared. ThemeToggle keeps it in step afterwards.
//
// The <link> is CREATED here rather than rendered from JSX. React 19 treats
// <link rel="icon"> in <head> as a hoistable element and hydrates it by
// finding an existing node whose attributes match the props; once this
// script had rewritten the href, nothing matched, React appended a second
// <link rel="icon" href="/logo-light.svg">, the browser honoured the last
// one, and every page except the static /frames shell showed the black
// outline on a dark tab strip. An element React never rendered is an
// element React never hydrates.
const themeScript = `(function(){try{
var c=document.cookie.split(";").map(function(p){return p.trim()}).filter(function(p){return p.indexOf("${themeCookieName}=")===0})[0];
var v=c?c.slice(${themeCookieName.length + 1}):null;
var t=(v==="dark"||v==="light")?v:null;
if(!t){var s=window.localStorage.getItem("${themeStorageKey}");
t=(s==="dark"||s==="light")?s:(window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light")}
document.documentElement.classList.toggle("theme-dark",t==="dark");
var h=window.location.hostname.toLowerCase();
var local=h==="localhost"||h.slice(-10)===".localhost"||h==="127.0.0.1"||h==="0.0.0.0"||h==="::1"||h==="[::1]";
var darkChrome=window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches;
var icon=document.querySelector("link[data-frameos-favicon]");
if(!icon){icon=document.createElement("link");icon.rel="icon";icon.type="image/svg+xml";icon.setAttribute("data-frameos-favicon","");document.head.appendChild(icon)}
icon.setAttribute("href","/logo-"+(darkChrome?"dark":"light")+(local?"-mono":"")+".svg");
}catch(e){}})()`;

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
        {/* No <link rel="icon"> here on purpose: themeScript creates it.
            The two things that pick the icon — the browser's colour scheme
            and the hostname the browser used — are both invisible to the
            server, and a JSX placeholder would be re-hoisted by React on
            hydration once the script changed its href (see themeScript). */}
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <PostHogProvider>
          <ThemeToggle cookieDomain={getSessionCookieDomain()} />
          {children}
          {/* Last in the body so it overlays without shifting the page, and
              so nothing above it depends on the visitor having answered. */}
          <AnalyticsConsentBanner cookieDomain={getSessionCookieDomain()} />
        </PostHogProvider>
      </body>
    </html>
  );
}
