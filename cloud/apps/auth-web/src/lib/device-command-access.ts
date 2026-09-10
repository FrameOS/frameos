// Whether a request's credential may put work on a frame's command queue.
//
// The csrf gate refuses a read-only API token (`fc_apiro_…`) on every
// mutating route, but several GETs queue a device command as a side effect
// of a cache miss — /asset and /image ask the device for bytes, /assets asks
// for a listing, /scene_images/{scene} for a snapshot. A read-only token is
// the credential handed to a dashboard that may only LOOK, and "look" must
// not include waking a battery frame or filling its queue; it gets whatever
// the hub already caches and nothing more.
export function sessionMayQueueDeviceCommands(session: {
  apiToken?: { access: string } | undefined;
}): boolean {
  return session.apiToken?.access !== "read_only";
}

// The refusal a read-only token gets when only the device could answer —
// same code the csrf gate uses for a mutation, so a client can tell the two
// apart from a real device failure.
export const readOnlyTokenError = "read_only_token";
