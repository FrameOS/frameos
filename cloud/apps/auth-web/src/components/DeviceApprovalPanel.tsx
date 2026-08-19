"use client";

import {
  Check,
  Clock,
  Link as LinkIcon,
  LogIn,
  RefreshCw,
  ShieldCheck,
  X,
} from "lucide-react";
import Link from "next/link";
import posthog from "posthog-js";
import { FormEvent, useEffect, useRef, useState } from "react";
import {
  baselineDeviceScopes,
  deviceScopeDescriptions,
  deviceScopeLabels,
} from "../lib/device-scopes";
import { redirectToReauthIfRequired } from "../lib/reauth-client";

type DeviceRequest = {
  client_kind?: "backend" | "frame";
  expires_at: string;
  local_origin?: string | null;
  public_display_name: string;
  requested_scopes: string[];
  scope_change?: boolean;
  signed_in: boolean;
  status: "pending" | "approved" | "denied" | "expired";
  user_code: string;
};

// "backend" (a FrameOS backend install) or "frame" (a frame linked directly).
function clientKindLabel(deviceRequest: DeviceRequest | undefined) {
  return deviceRequest?.client_kind === "frame" ? "frame" : "backend";
}

type ActionState =
  | { kind: "idle" }
  | { kind: "loading"; message: string }
  | { kind: "error"; message: string }
  | { kind: "success"; message: string };

export function DeviceApprovalPanel({
  initialReturnTo,
  initialUserCode,
}: {
  initialReturnTo?: string | undefined;
  initialUserCode?: string | undefined;
}) {
  const [userCode, setUserCode] = useState(initialUserCode ?? "");
  const [deviceRequest, setDeviceRequest] = useState<
    DeviceRequest | undefined
  >();
  const [state, setState] = useState<ActionState>({ kind: "idle" });
  // Monotonic id per lookup so a slow response can't overwrite the state of a
  // lookup the user started later.
  const lookupSeq = useRef(0);
  const signInReturnPath = deviceReturnPath(userCode, initialReturnTo);
  const signInHref = `/login?return_to=${encodeURIComponent(signInReturnPath)}`;

  async function lookup(nextUserCode = userCode) {
    const normalized = nextUserCode.trim();
    if (!normalized) {
      setState({
        kind: "error",
        message: "Enter the code shown by your FrameOS backend or frame.",
      });
      return;
    }

    const seq = ++lookupSeq.current;
    setState({ kind: "loading", message: "Finding your device" });
    const response = await fetch(
      `/api/device/request?user_code=${encodeURIComponent(normalized)}`,
    );
    const payload = (await response.json()) as
      | DeviceRequest
      | { error?: string };
    if (seq !== lookupSeq.current) {
      return;
    }
    if (!response.ok) {
      setDeviceRequest(undefined);
      setState({
        kind: "error",
        message: ("error" in payload ? payload.error : undefined) ?? "Invalid code",
      });
      return;
    }

    setDeviceRequest(payload as DeviceRequest);
    setState({ kind: "idle" });
  }

  async function decide(action: "authorize" | "deny") {
    if (!deviceRequest) {
      return;
    }

    const kindLabel = clientKindLabel(deviceRequest);
    setState({
      kind: "loading",
      message:
        action === "authorize"
          ? `Connecting ${kindLabel}`
          : "Canceling connection",
    });
    const response = await fetch(`/api/device/${action}`, {
      body: JSON.stringify({ user_code: deviceRequest.user_code }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const payload = (await response.json()) as {
      error?: string;
      status?: string;
    };
    if (!response.ok) {
      // The page already routed a stale session through /login/reauth; this
      // catches the window expiring while the panel was open.
      if (redirectToReauthIfRequired(response, payload)) {
        return;
      }
      setState({
        kind: "error",
        message: payload.error ?? "Request failed",
      });
      return;
    }

    const nextDeviceRequest = {
      ...deviceRequest,
      // Fall back to the action's expected outcome if the server returns a
      // status the UI doesn't know.
      status:
        parseStatus(payload.status) ??
        (action === "authorize" ? ("approved" as const) : ("denied" as const)),
    };
    setDeviceRequest(nextDeviceRequest);
    setState({
      kind: "success",
      message:
        action === "authorize"
          ? `${kindLabel === "frame" ? "Frame" : "Backend"} connected`
          : "Connection canceled",
    });

    if (action === "authorize") {
      const eventName = deviceRequest.scope_change
        ? "backend_scopes_updated"
        : "backend_connected";
      posthog.capture(eventName, { client_kind: deviceRequest.client_kind ?? "backend" });
    } else {
      posthog.capture("backend_connection_denied", { client_kind: deviceRequest.client_kind ?? "backend" });
    }

    const returnUrl =
      action === "authorize"
        ? frameosReturnUrl(nextDeviceRequest, initialReturnTo)
        : undefined;
    if (returnUrl) {
      window.location.href = returnUrl;
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void lookup();
  }

  useEffect(() => {
    if (initialUserCode) {
      void lookup(initialUserCode);
    }
  }, [initialUserCode]);

  // Approving is what hands a device a token on this account, and the whole
  // request — display name, reported address — is written by whoever called
  // device/start. Following verification_uri_complete used to put the approve
  // button one click away with nothing in between, so a link was enough to
  // get an unwitting owner to connect an attacker's client. When the code
  // arrived in the URL rather than being typed, the user has to confirm they
  // started it.
  const codeCameFromLink = Boolean(initialUserCode);
  const [confirmedOwnRequest, setConfirmedOwnRequest] = useState(false);
  const needsConfirmation = codeCameFromLink && !confirmedOwnRequest;
  const canDecide =
    deviceRequest?.status === "pending" && deviceRequest.signed_in;
  // Linking scopes are implied by connecting at all; only list the features
  // the user explicitly enabled in FrameOS.
  const featureScopes =
    deviceRequest?.requested_scopes.filter(
      (scope) => !baselineDeviceScopes.has(scope),
    ) ?? [];
  const status = deviceRequest
    ? statusDisplay(deviceRequest.status)
    : undefined;
  // A code in the URL skips straight to the request; only fall back to the
  // manual code form when that lookup fails and there is nothing to show.
  const showCodeForm =
    !initialUserCode || (state.kind === "error" && !deviceRequest);

  return (
    <div className="device-connect stack-lg">
      {showCodeForm ? (
        <form className="card device-code-form" onSubmit={submit}>
          <div className="field">
            <label htmlFor="user_code">Code from backend or frame</label>
            <input
              className="input code-input"
              id="user_code"
              inputMode="text"
              onChange={(event) => setUserCode(event.target.value)}
              placeholder="H7LU-JLWN"
              value={userCode}
            />
          </div>
          <button className="button" type="submit">
            <RefreshCw aria-hidden size={18} />
            Find device
          </button>
        </form>
      ) : null}

      {state.kind !== "idle" ? (
        <p
          className={state.kind === "error" ? "notice notice-error" : "notice"}
        >
          {state.message}
        </p>
      ) : null}

      {deviceRequest ? (
        <section className="card device-request-card">
          <div className="device-request-card__header">
            <div className="device-icon" aria-hidden>
              <LinkIcon size={24} />
            </div>
            <div>
              <p className="eyebrow">
                {clientKindLabel(deviceRequest) === "frame"
                  ? "FrameOS frame"
                  : "FrameOS backend"}
              </p>
              <h2>{deviceRequest.public_display_name}</h2>
              <p className="copy">
                {deviceRequest.scope_change
                  ? "Wants to change which features are enabled for its cloud connection."
                  : "Wants to connect to your FrameOS Cloud account."}
              </p>
            </div>
            <span className={status?.className}>{status?.label}</span>
          </div>

          <div className="device-detail-grid">
            <div>
              <p className="detail-label">Connection code</p>
              <p className="device-code">{deviceRequest.user_code}</p>
            </div>
            <div>
              <p className="detail-label">Request from (reported)</p>
              <p>
                {deviceRequest.local_origin ??
                  "The backend did not report a local address"}
              </p>
            </div>
            <div>
              <p className="detail-label">Expires</p>
              <p>
                <Clock aria-hidden size={16} />
                {new Date(deviceRequest.expires_at).toLocaleTimeString(
                  undefined,
                  { timeZoneName: "short" },
                )}
              </p>
            </div>
          </div>

          <div className="device-permissions">
            <div>
              <ShieldCheck aria-hidden size={20} />
              <h3>Enabled features</h3>
            </div>
            {featureScopes.length > 0 ? (
              <ul>
                {featureScopes.map((scope) => (
                  <li key={scope}>
                    <strong>{scopeLabel(scope)}</strong>
                    {" — "}
                    <span>{scopeDescription(scope)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="copy">
                None — just the basic cloud connection.
              </p>
            )}
          </div>

          <p className="notice">
            {deviceRequest.scope_change && deviceRequest.status === "approved"
              ? "Features updated. You may now close this window."
              : statusMessage(deviceRequest.status, clientKindLabel(deviceRequest))}
          </p>

          {!deviceRequest.signed_in ? (
            <div className="device-auth-callout">
              <p>
                Sign in to finish connecting this{" "}
                {clientKindLabel(deviceRequest)}.
              </p>
              <Link className="button button-primary" href={signInHref}>
                <LogIn aria-hidden size={18} />
                Sign in to continue
              </Link>
            </div>
          ) : null}

          {canDecide && needsConfirmation ? (
            <div className="device-auth-callout">
              <p>
                You opened this from a link. The name and address above are
                reported by the device itself and are not verified — only
                continue if you just started this connection yourself.
              </p>
              <label className="checkbox">
                <input
                  checked={confirmedOwnRequest}
                  onChange={(event) =>
                    setConfirmedOwnRequest(event.target.checked)
                  }
                  type="checkbox"
                />{" "}
                I started this connection on my own {clientKindLabel(deviceRequest)}
              </label>
            </div>
          ) : null}

          {canDecide ? (
            <div className="inline-actions">
              <button
                className="button button-primary"
                disabled={needsConfirmation}
                onClick={() => void decide("authorize")}
                type="button"
              >
                <Check aria-hidden size={18} />
                {deviceRequest.scope_change
                  ? "Approve changes"
                  : `Connect ${clientKindLabel(deviceRequest)}`}
              </button>
              <button
                className="button button-danger"
                onClick={() => void decide("deny")}
                type="button"
              >
                <X aria-hidden size={18} />
                Don&apos;t connect
              </button>
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

function parseStatus(value: unknown): DeviceRequest["status"] | undefined {
  return value === "pending" ||
    value === "approved" ||
    value === "denied" ||
    value === "expired"
    ? value
    : undefined;
}

function scopeDescription(scope: string) {
  return deviceScopeDescriptions[scope] ?? `Use the ${scope} permission`;
}

function scopeLabel(scope: string) {
  return deviceScopeLabels[scope] ?? scope;
}

function statusDisplay(status: DeviceRequest["status"]) {
  if (status === "approved") {
    return { className: "pill pill-ok", label: "Connected" };
  }

  if (status === "denied") {
    return { className: "pill pill-warning", label: "Canceled" };
  }

  if (status === "expired") {
    return { className: "pill pill-warning", label: "Expired" };
  }

  return { className: "pill", label: "Waiting for approval" };
}

function statusMessage(status: DeviceRequest["status"], kindLabel: string) {
  if (status === "approved") {
    return `This ${kindLabel} is connected. You may now close this window.`;
  }

  if (status === "denied") {
    return `This request was canceled. Start a new connection from the ${kindLabel} if you changed your mind.`;
  }

  if (status === "expired") {
    return `This request expired. Start a new connection from the ${kindLabel} to get a fresh code.`;
  }

  return `Approve only if this is the ${kindLabel} you just opened.`;
}

function deviceReturnPath(userCode: string, returnTo: string | undefined) {
  const params = new URLSearchParams();
  if (userCode.trim()) {
    params.set("user_code", userCode.trim());
  }
  if (returnTo) {
    params.set("return_to", returnTo);
  }
  const query = params.toString();
  return `/device${query ? `?${query}` : ""}`;
}

function frameosReturnUrl(
  deviceRequest: DeviceRequest,
  rawReturnTo: string | undefined,
) {
  if (!deviceRequest.local_origin) {
    return undefined;
  }

  if (!rawReturnTo) {
    return undefined;
  }

  try {
    const localOrigin = new URL(deviceRequest.local_origin);
    const returnTo = new URL(rawReturnTo);
    if (!["http:", "https:"].includes(returnTo.protocol)) {
      return undefined;
    }
    if (returnTo.origin !== localOrigin.origin) {
      return undefined;
    }
    return returnTo.toString();
  } catch {
    return undefined;
  }
}
