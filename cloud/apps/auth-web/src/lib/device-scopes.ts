// Scopes a FrameOS backend (or frame) may request through the device
// authorization flow. This module is free of server-only imports so the
// device approval UI can show the exact descriptions being granted.

export const defaultDeviceScopes = ["backend:link", "backend:read"];

export const deviceScopeDescriptions: Record<string, string> = {
  "auth:login":
    "Sign users in to this backend with their FrameOS Cloud account",
  "backend:link": "Register this backend with your FrameOS Cloud account",
  "backend:read": "Read basic backend connection details",
  "backup:assets":
    "Store encrypted backups of frame assets (may require a paid plan)",
  "backup:frames":
    "Store encrypted backups of frame configurations (may require a paid plan)",
  "backup:scenes":
    "Store encrypted backups of your scenes (may require a paid plan)",
  "frame:link":
    "Link a frame directly to your FrameOS Cloud account without a backend",
  "gallery:read": "Show curated images from the FrameOS gallery on frames",
  "remote:access":
    "Open a relay so this backend can be reached from cloud.frameos.net (may require a paid plan)",
  "store:publish":
    "Save scenes from this backend to your cloud account and share them on the FrameOS store",
  "store:read": "Browse and install scenes from the FrameOS store",
  "telemetry:logs":
    "Send frame and backend logs to FrameOS Cloud (may require a paid plan)",
  "telemetry:metrics":
    "Send frame and backend metrics to FrameOS Cloud (may require a paid plan)",
};

// Human names shown on the approval screen ("Cloud login" instead of
// "auth:login"). Base link scopes carry no user-visible feature.
export const deviceScopeLabels: Record<string, string> = {
  "auth:login": "Cloud login",
  "backend:link": "Backend link",
  "backend:read": "Backend details",
  "backup:assets": "Asset backups",
  "backup:frames": "Frame backups",
  "backup:scenes": "Scene backups",
  "frame:link": "Frame link",
  "gallery:read": "Gallery access",
  "remote:access": "Remote access",
  "store:publish": "Save and share scenes",
  "store:read": "Store access",
  "telemetry:logs": "Log shipping",
  "telemetry:metrics": "Metrics shipping",
};

// Scopes implied by the connection itself. The approval screen folds these
// into the connect/approve action instead of listing them as features next
// to the ones the user explicitly toggled on in FrameOS.
export const baselineDeviceScopes = new Set([
  "backend:link",
  "backend:read",
  "frame:link",
]);

// Features that come with every cloud account. When a linked client asks to
// add one of these to an existing link (POST /api/backends/scopes), it is
// granted without a consent screen — only security-sensitive scopes (login,
// remote access, telemetry, ...) need the owner's approval.
export const autoGrantedDeviceScopes = new Set([
  "backup:frames",
  "backup:scenes",
  "store:publish",
]);

export const allowedDeviceScopes = new Set(
  Object.keys(deviceScopeDescriptions),
);
