import type { Instrumentation } from "next";

// Whatever a route handler or page throws and nothing caught goes to the error
// tracker. `reportError` only covers the failures somebody wrote a call for:
// an object store PUT that R2 refused took down store saves and photo uploads
// on 2026-11-10 with a line in the journal and nothing in PostHog.
//
// The route's pattern and never the request's path: a path can hold a token
// (a frame's view link, a share link), and neither may reach a log or a third
// party.
export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }
  const { captureServerException } = await import("./lib/error-tracking");
  await captureServerException({
    error,
    event: "next.request_error",
    fields: {
      method: request.method,
      routePath: context.routePath,
      routeType: context.routeType,
    },
  });
};
