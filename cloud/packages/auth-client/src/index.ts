import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

export const frameosCloudAuthScopes = ["openid", "profile", "email"];
export const defaultFrameosAuthProviderUrl = "https://cloud.frameos.net";

export type OidcDiscovery = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
};

export type TokenSet = {
  access_token?: string;
  expires_in?: number;
  id_token: string;
  refresh_token?: string;
  scope?: string;
  token_type: string;
};

export type VerifiedIdTokenClaims = JWTPayload & {
  email?: string;
  email_verified?: boolean;
  name?: string;
  sub: string;
};

export type FrameosAuthProviderConfig =
  | {
      disabled: true;
      providerUrl?: undefined;
    }
  | {
      disabled: false;
      providerUrl: string;
    };

export type DeviceAuthorizationStartResponse = {
  device_code: string;
  expires_in: number;
  interval: number;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
};

export type DeviceAuthorizationPollResponse =
  | {
      error: "authorization_pending" | "slow_down";
      interval?: number;
    }
  | {
      error: "access_denied" | "expired_token" | "invalid_device_code";
    }
  | {
      access_token: string;
      linked_client_id: string;
      scope: string;
      token_reference: string;
      token_type: "Bearer";
    };

export type RequestOptions = {
  fetchImpl?: typeof fetch;
  // Forwarded to fetch so callers can enforce timeouts (AbortSignal.timeout)
  // or cancel in-flight requests instead of hanging on a stalled network.
  signal?: AbortSignal;
};

const retryablePollErrors = new Set(["authorization_pending", "slow_down"]);
const terminalPollErrors = new Set([
  "access_denied",
  "expired_token",
  "invalid_device_code",
]);

export function normalizeFrameosAuthProviderUrl(
  value: string | null | undefined,
  defaultProviderUrl = defaultFrameosAuthProviderUrl,
): FrameosAuthProviderConfig {
  const normalized = value?.trim();
  if (normalized?.toLowerCase() === "disabled") {
    return { disabled: true };
  }

  const providerUrl =
    normalized && normalized.length > 0 ? normalized : defaultProviderUrl;
  const url = new URL(providerUrl);
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";

  return {
    disabled: false,
    providerUrl: url.toString().replace(/\/$/, ""),
  };
}

export async function discoverOidcProvider(
  issuerUrl: string,
  options: RequestOptions = {},
): Promise<OidcDiscovery> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const issuer = issuerUrl.replace(/\/+$/, "");
  const response = await fetchImpl(
    `${issuer}/.well-known/openid-configuration`,
    {
      headers: { accept: "application/json" },
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );

  if (!response.ok) {
    throw new Error(`OIDC discovery failed for ${issuer}: ${response.status}`);
  }

  const metadata = (await response.json()) as Partial<OidcDiscovery>;
  if (
    !metadata.issuer ||
    !metadata.authorization_endpoint ||
    !metadata.token_endpoint ||
    !metadata.jwks_uri
  ) {
    throw new Error(
      `OIDC discovery response from ${issuer} is missing required endpoints`,
    );
  }

  return {
    authorization_endpoint: metadata.authorization_endpoint,
    issuer: metadata.issuer,
    jwks_uri: metadata.jwks_uri,
    token_endpoint: metadata.token_endpoint,
  };
}

export async function startDeviceAuthorization(
  providerUrl: string,
  request: {
    capabilities?: unknown;
    local_origin?: string;
    public_display_name: string;
    reported_frameos_version?: string;
    scopes?: string[];
  },
  options: RequestOptions = {},
): Promise<DeviceAuthorizationStartResponse> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(new URL("/api/device/start", providerUrl), {
    body: JSON.stringify(request),
    headers: { "content-type": "application/json" },
    method: "POST",
    ...(options.signal ? { signal: options.signal } : {}),
  });

  if (!response.ok) {
    throw new Error(
      `FrameOS Cloud device authorization start failed: ${response.status}`,
    );
  }

  return (await response.json()) as DeviceAuthorizationStartResponse;
}

export async function pollDeviceAuthorization(
  providerUrl: string,
  deviceCode: string,
  options: RequestOptions = {},
): Promise<DeviceAuthorizationPollResponse> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(new URL("/api/device/poll", providerUrl), {
    body: JSON.stringify({ device_code: deviceCode }),
    headers: { "content-type": "application/json" },
    method: "POST",
    ...(options.signal ? { signal: options.signal } : {}),
  });

  // The poll contract uses non-2xx statuses for normal protocol states
  // (authorization_pending is 428, access_denied is 403), so dispatch on the
  // payload, not response.ok — but never trust a body we can't parse.
  const payload: unknown = await response.json().catch(() => undefined);
  const record =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : undefined;

  if (response.ok && typeof record?.access_token === "string") {
    return record as Extract<
      DeviceAuthorizationPollResponse,
      { access_token: string }
    >;
  }

  const error = typeof record?.error === "string" ? record.error : undefined;

  if (response.status === 429) {
    // Rate limited: tell callers to back off using the server's retry-after.
    const retryAfter = Number(record?.retry_after);
    return {
      error: "slow_down",
      ...(Number.isFinite(retryAfter) && retryAfter > 0
        ? { interval: retryAfter }
        : {}),
    };
  }

  if (error && retryablePollErrors.has(error)) {
    const interval = Number(record?.interval);
    return {
      error: error as "authorization_pending" | "slow_down",
      ...(Number.isFinite(interval) && interval > 0 ? { interval } : {}),
    };
  }

  if (error && terminalPollErrors.has(error)) {
    return {
      error: error as "access_denied" | "expired_token" | "invalid_device_code",
    };
  }

  throw new Error(
    `FrameOS Cloud device authorization poll failed: ${response.status}`,
  );
}

export function createRandomToken(byteLength = 32) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

export async function createPkcePair() {
  const verifier = createRandomToken(48);
  const challengeBytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return {
    challenge: base64UrlEncode(new Uint8Array(challengeBytes)),
    verifier,
  };
}

export function buildAuthorizationUrl(
  discovery: OidcDiscovery,
  options: {
    clientId: string;
    codeChallenge: string;
    extraParams?: Record<string, string>;
    nonce: string;
    redirectUri: string;
    scopes: string[];
    state: string;
  },
) {
  const url = new URL(discovery.authorization_endpoint);
  url.searchParams.set("client_id", options.clientId);
  url.searchParams.set("code_challenge", options.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("nonce", options.nonce);
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", options.scopes.join(" "));
  url.searchParams.set("state", options.state);

  for (const [key, value] of Object.entries(options.extraParams ?? {})) {
    url.searchParams.set(key, value);
  }

  return url;
}

export async function exchangeAuthorizationCode(
  discovery: OidcDiscovery,
  options: {
    clientId: string;
    clientSecret: string;
    code: string;
    codeVerifier: string;
    redirectUri: string;
  },
  requestOptions: RequestOptions = {},
): Promise<TokenSet> {
  const fetchImpl = requestOptions.fetchImpl ?? fetch;
  const body = new URLSearchParams({
    client_id: options.clientId,
    code: options.code,
    code_verifier: options.codeVerifier,
    grant_type: "authorization_code",
    redirect_uri: options.redirectUri,
  });

  const response = await fetchImpl(discovery.token_endpoint, {
    body,
    headers: {
      accept: "application/json",
      authorization: `Basic ${Buffer.from(
        `${options.clientId}:${options.clientSecret}`,
      ).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    method: "POST",
    ...(requestOptions.signal ? { signal: requestOptions.signal } : {}),
  });

  if (!response.ok) {
    throw new Error(`OIDC token exchange failed: ${response.status}`);
  }

  const tokenSet = (await response.json()) as Partial<TokenSet>;
  if (!tokenSet.id_token || !tokenSet.token_type) {
    throw new Error("OIDC token response is missing id_token or token_type");
  }

  return tokenSet as TokenSet;
}

export async function verifyOidcIdToken(
  idToken: string,
  options: {
    audience: string;
    issuer: string;
    jwksUri: string;
    nonce: string;
  },
) {
  const jwks = createRemoteJWKSet(new URL(options.jwksUri));
  const verified = await jwtVerify(idToken, jwks, {
    audience: options.audience,
    issuer: options.issuer,
  });

  if (verified.payload.nonce !== options.nonce) {
    throw new Error("OIDC id_token nonce mismatch");
  }

  if (!verified.payload.sub) {
    throw new Error("OIDC id_token is missing subject");
  }

  return verified.payload as VerifiedIdTokenClaims;
}

function base64UrlEncode(bytes: Uint8Array) {
  return Buffer.from(bytes)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
