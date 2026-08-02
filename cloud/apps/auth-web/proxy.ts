import { NextRequest, NextResponse } from "next/server";
import { resolveSurfaceRoute } from "./src/lib/surfaces";

export function proxy(request: NextRequest) {
  const route = resolveSurfaceRoute(
    request.nextUrl,
    request.headers.get("host"),
  );
  if (!route) {
    return NextResponse.next();
  }
  if (route.kind === "redirect") {
    return NextResponse.redirect(route.destination, 308);
  }

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(
    "x-frameos-account-return-to",
    `${request.nextUrl.pathname}${request.nextUrl.search}`,
  );
  const destination = route.destination;
  // Nginx terminates TLS and forwards to Next over plain HTTP. Next can
  // normalize that proxied request as https://localhost:3000; without this
  // correction an absolute rewrite attempts TLS against the HTTP listener.
  if (
    destination.hostname === "localhost" &&
    destination.protocol === "https:"
  ) {
    destination.protocol = "http:";
  }
  return NextResponse.rewrite(destination, {
    request: { headers: requestHeaders },
  });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"],
};
