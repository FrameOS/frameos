import type { Metadata } from "next";
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

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <PostHogProvider>
          <ThemeToggle cookieDomain={getSessionCookieDomain()} />
          {children}
        </PostHogProvider>
      </body>
    </html>
  );
}
