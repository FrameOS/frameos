"use client";

import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  isReauthRequired,
  redirectToReauthIfRequired,
  takePendingReauthAction,
} from "../lib/reauth-client";

const resumeAction = "billing-sync-plans";

// "Sync plans" on /admin/billing/customers and /admin/billing/payments:
// writes the catalog's self-serve stops as billing_plans rows and, with
// Stripe set up, makes them buyable there in its current mode. The route is
// behind sudo mode, so a session that has not proved itself lately goes
// through /login/reauth and the sync runs on the way back.
export function BillingPlanSyncButton({ disabled = false }: { disabled?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | undefined>();
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | undefined>();

  // Back from /login/reauth: finish the sync that was asked for.
  useEffect(() => {
    if (takePendingReauthAction(resumeAction)) {
      void sync({ resumed: true });
    }
  }, []);

  async function sync({ resumed = false } = {}) {
    setBusy(true);
    setError(undefined);
    setMessage(undefined);
    setWarnings([]);
    try {
      const response = await fetch("/api/admin/billing/plans", {
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const body = (await response.json().catch(() => ({}))) as {
        checks?: {
          tax_status: string | null;
          webhook: { api_version: string | null; enabled: boolean; found: boolean; missing_events: string[] };
        };
        detail?: string;
        error?: string;
        plans?: { created: boolean }[];
        provider?: string | null;
        provider_problem?: string;
      };
      if (!response.ok) {
        // A second refusal straight after confirming is an error to show,
        // not a loop to go round again.
        if (
          !(resumed && isReauthRequired(response, body)) &&
          redirectToReauthIfRequired(response, body, resumeAction)
        ) {
          return;
        }
        setError(body.detail ?? "Could not sync the plans. Try again in a moment.");
        return;
      }
      const plans = body.plans ?? [];
      const created = plans.filter((plan) => plan.created).length;
      setMessage(
        body.provider
          ? created > 0
            ? `${plans.length} plans in place, ${created} new prices at Stripe.`
            : `${plans.length} plans in place at Stripe.`
          : `${plans.length} plans in place.`,
      );
      const found: string[] = [];
      if (body.provider_problem) {
        found.push(`Stripe is not set up: ${body.provider_problem}`);
      }
      if (body.checks) {
        if (body.checks.tax_status !== "active") {
          found.push(
            body.checks.tax_status
              ? `Stripe Tax is ${body.checks.tax_status}: add the head office address and a registration in Stripe's tax settings.`
              : "Stripe Tax could not be read with this key.",
          );
        }
        if (!body.checks.webhook.found) {
          found.push("No Stripe webhook endpoint points at this deployment.");
        } else if (!body.checks.webhook.enabled) {
          found.push("The Stripe webhook endpoint is disabled.");
        } else if (body.checks.webhook.missing_events.length > 0) {
          found.push(`The webhook endpoint does not send ${body.checks.webhook.missing_events.join(", ")}.`);
        }
        if (body.checks.webhook.api_version) {
          found.push(
            `The webhook endpoint sends events in API version ${body.checks.webhook.api_version}. Notices are read back in ours, so it works, but set it to ours when you next touch it.`,
          );
        }
      }
      setWarnings(found);
      router.refresh();
    } catch {
      setError("Could not sync the plans. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        className="button button--small"
        disabled={busy || disabled}
        onClick={() => void sync()}
        type="button"
      >
        <RefreshCw aria-hidden size={16} />
        {busy ? "Syncing…" : "Sync plans"}
      </button>
      {message ? <span className="pill">{message}</span> : null}
      {warnings.map((warning) => (
        <span className="pill pill-warning" key={warning}>
          {warning}
        </span>
      ))}
      {error ? (
        <span className="pill pill-warning" role="alert">
          {error}
        </span>
      ) : null}
    </>
  );
}
