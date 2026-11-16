import type { Metadata, Viewport } from "next";
import { Playground } from "../../src/components/Playground";
import "./playground.css";

// playground.frameos.net (cloud/docs/playground.md); src/lib/surfaces.ts
// serves this page at that host's root.
export const metadata: Metadata = {
  title: "FrameOS playground",
  description:
    "FrameOS running in your browser: a desktop of scenes side by side, and the scene store.",
};

export const viewport: Viewport = {
  initialScale: 1,
  width: "device-width",
};

export default function PlaygroundPage() {
  return <Playground />;
}
