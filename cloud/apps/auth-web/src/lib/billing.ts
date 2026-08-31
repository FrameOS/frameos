// The route-facing face of the accounting module. Everything in
// packages/ledger is Next-free and throws on bad input; everything here is
// shaped for a request handler, and the metering half of it never throws at
// all.
//
// That last part is the rule worth stating: **a metering failure must never
// change what the user got.** A chat turn that produced a scene has produced
// it; if the ledger cannot be written afterwards, the answer is still
// delivered, the failure is reported, and the nightly sweep picks the
// measurement back up (packages/ledger/src/metering.ts explains why the
// record commits before the entries). The alternative — a 500 on a finished
// turn because the books hiccuped — trades the thing the user came for
// against a number we can reconcile later anyway.

import { createDb } from "@frameos-cloud/db";
import {
  recordAiUsage,
  type AiUsageInput,
  type CredentialSource,
} from "@frameos-cloud/ledger";
import { hasDatabaseUrl } from "./env";
import { logInfo, reportError } from "./log";

export type { CredentialSource };

export interface MeterAiUsageInput extends Omit<AiUsageInput, "usage"> {
  // As the provider reported it: `inputTokens` still including the cached
  // ones. The ledger splits them.
  usage: {
    cachedInputTokens?: number | undefined;
    inputTokens?: number | undefined;
    outputTokens?: number | undefined;
    reasoningTokens?: number | undefined;
  };
}

// Meter one AI turn. Fire-and-forget from a route's onFinish: awaited where
// the caller can afford it, `void`ed where it cannot, and silent on success
// apart from one structured line per metered turn.
export async function meterAiUsage(input: MeterAiUsageInput): Promise<void> {
  if (!hasDatabaseUrl()) {
    return;
  }
  try {
    const result = await recordAiUsage(createDb(), input);
    if (result.replayed) {
      return;
    }
    logInfo("billing.ai_usage_metered", {
      accountId: input.accountId ?? undefined,
      costMicros: result.record.costMicros.toString(),
      credentialSource: input.credentialSource,
      meteringMode: result.record.meteringMode,
      model: input.model,
      posted: result.posted,
      priceMicros: result.record.priceMicros.toString(),
      surface: input.surface ?? undefined,
      turnId: input.turnId,
    });
    if (result.postError) {
      // The measurement is safe; only the journal entry is missing, and the
      // nightly sweep owns it from here.
      reportError("billing.ai_usage_post_failed", result.postError, {
        accountId: input.accountId ?? undefined,
        turnId: input.turnId,
      });
    }
  } catch (error) {
    reportError("billing.ai_usage_meter_failed", error, {
      accountId: input.accountId ?? undefined,
      turnId: input.turnId,
    });
  }
}

// Fire-and-forget form, for the places that must not await: a chat turn's
// onFinish is a synchronous observer the turn runner calls while tearing
// down, and blocking it would hold the turn open.
export function meterAiUsageInBackground(input: MeterAiUsageInput): void {
  void meterAiUsage(input);
}
