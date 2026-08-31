import { createDb } from "@frameos-cloud/db";
import {
  LedgerError,
  manualJournalEventType,
  postEvent,
  reclassificationEventType,
  reverseEntry,
} from "@frameos-cloud/ledger";
import { NextRequest, NextResponse } from "next/server";
import { getSuperadminContext } from "../../../../../src/lib/admin";
import { recordAuditEvent } from "../../../../../src/lib/audit";
import { csrfResponse } from "../../../../../src/lib/csrf";
import {
  jsonError,
  readJsonObject,
  requireDatabase,
} from "../../../../../src/lib/device-flow";
import { rateLimitResponse } from "../../../../../src/lib/rate-limit";
import { readSession } from "../../../../../src/lib/session";

export const runtime = "nodejs";

// The three ways a human writes to the journal, behind one endpoint because
// they are one act: stating something the automated recipes cannot.
//
//   manual_journal  — legs stated outright: an opening balance, a provider
//                     invoice settled by hand, a correction nobody wrote a
//                     rule for.
//   reclassify      — an amount is in the wrong account (§1.3 mechanism 2).
//   reverse         — an entry was wrong; mirror it and, if something
//                     correct belongs in its place, post that separately.
//
// None of them edits anything. Every one of them goes through the posting
// kernel like any other event, so it is idempotent, reversible, attached to
// a financial_events row that says who asked for it, and recorded in the
// audit trail besides. There is deliberately no route that writes a posting
// directly — the kernel is the only writer, and this is a human speaking to
// it rather than around it.
//
// Superadmin only, and every action needs a reason: the books have to say
// why, and "because an admin said so" is not why.
export async function POST(request: NextRequest) {
  const csrf = csrfResponse(request);
  if (csrf) {
    return csrf;
  }
  const limited = await rateLimitResponse(request, "admin:billing-journal", {
    limit: 60,
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }
  const admin = await getSuperadminContext();
  if (admin.kind !== "ok") {
    return jsonError(
      admin.kind === "forbidden" ? "forbidden" : "unauthenticated",
      admin.kind === "forbidden" ? 403 : 401,
    );
  }
  const { db, response } = requireDatabase();
  if (!db) {
    return response;
  }

  const session = await readSession();
  const body = await readJsonObject(request);
  const action = typeof body.action === "string" ? body.action : "";
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (!reason) {
    return jsonError("reason_required", 400, {
      detail: "Say why this is being posted; it goes into the books.",
    });
  }

  try {
    switch (action) {
      case "manual_journal":
        return await postManualJournal(db, admin.accountId, body, reason, session?.providerSubject);
      case "reclassify":
        return await postReclassification(db, admin.accountId, body, reason, session?.providerSubject);
      case "reverse":
        return await postReversal(db, admin.accountId, body, reason, session?.providerSubject);
      default:
        return jsonError("invalid_action", 400, {
          detail: 'action must be "manual_journal", "reclassify" or "reverse"',
        });
    }
  } catch (error) {
    if (error instanceof LedgerError) {
      // The ledger's own refusals are the useful message here — "entry is out
      // of balance by 1000 USD micros" is what the admin needs to see.
      return jsonError(error.code, 400, { detail: error.message });
    }
    throw error;
  }
}

type Db = ReturnType<typeof createDb>;

async function postManualJournal(
  db: Db,
  adminAccountId: string,
  body: Record<string, unknown>,
  reason: string,
  providerSubject: string | undefined,
) {
  const legs = Array.isArray(body.legs) ? body.legs : [];
  if (legs.length < 2) {
    return jsonError("invalid_legs", 400, {
      detail: "A journal entry needs at least two legs.",
    });
  }
  const accountId = typeof body.accountId === "string" ? body.accountId : null;
  const result = await postEvent(db, {
    accountId,
    eventType: manualJournalEventType,
    // Stated by a human, so the dedupe handle is the act rather than
    // anything the system generated: two clicks of the same form are two
    // facts, and only a resubmitted request is one.
    idempotencyKey: idempotencyKey(body, `manual:${adminAccountId}`),
    payload: {
      description: reason,
      ...(typeof body.externalRef === "string" ? { externalRef: body.externalRef } : {}),
      legs,
      metadata: { postedBy: adminAccountId },
    },
    source: "admin",
    sourceRef: adminAccountId,
  });

  await recordAuditEvent(db, {
    ...(accountId ? { accountId } : {}),
    actor: { accountId: adminAccountId, kind: "superadmin", providerSubject },
    eventType: "billing.manual_journal",
    metadata: { entryIds: result.entries.map((entry) => entry.id), reason },
    target: { eventId: result.event.id },
  });
  return NextResponse.json({ entries: describeEntries(result.entries), ok: true });
}

async function postReclassification(
  db: Db,
  adminAccountId: string,
  body: Record<string, unknown>,
  reason: string,
  providerSubject: string | undefined,
) {
  const result = await postEvent(db, {
    accountId: typeof body.accountId === "string" ? body.accountId : null,
    eventType: reclassificationEventType,
    idempotencyKey: idempotencyKey(body, `reclass:${adminAccountId}`),
    payload: {
      amountMicros: body.amountMicros,
      creditAccountCode: body.creditAccountCode,
      debitAccountCode: body.debitAccountCode,
      reason,
      ...(typeof body.reclassifiesEntryId === "string"
        ? { reclassifiesEntryId: body.reclassifiesEntryId }
        : {}),
    },
    source: "admin",
    sourceRef: adminAccountId,
  });

  await recordAuditEvent(db, {
    actor: { accountId: adminAccountId, kind: "superadmin", providerSubject },
    eventType: "billing.reclassification",
    metadata: {
      creditAccountCode: body.creditAccountCode,
      debitAccountCode: body.debitAccountCode,
      reason,
    },
    target: { eventId: result.event.id },
  });
  return NextResponse.json({ entries: describeEntries(result.entries), ok: true });
}

async function postReversal(
  db: Db,
  adminAccountId: string,
  body: Record<string, unknown>,
  reason: string,
  providerSubject: string | undefined,
) {
  const entryId = typeof body.entryId === "string" ? body.entryId : "";
  if (!entryId) {
    return jsonError("invalid_entry", 400, {
      detail: "Which entry is being reversed?",
    });
  }
  const result = await reverseEntry(db, {
    accountId: typeof body.accountId === "string" ? body.accountId : null,
    entryId,
    reason,
    source: "admin",
  });

  await recordAuditEvent(db, {
    actor: { accountId: adminAccountId, kind: "superadmin", providerSubject },
    eventType: "billing.reversal",
    metadata: { reason, replayed: result.replayed },
    target: { entryId },
  });
  return NextResponse.json({
    entries: describeEntries(result.entries),
    ok: true,
    replayed: result.replayed,
  });
}

// A client-supplied key makes a double-submitted form one fact; without one,
// each request is its own.
function idempotencyKey(body: Record<string, unknown>, prefix: string): string {
  const supplied = typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim() : "";
  return supplied ? `${prefix}:${supplied}` : `${prefix}:${crypto.randomUUID()}`;
}

function describeEntries(
  entries: {
    entryType: string;
    id: string;
    postings: { amountMicros: bigint; direction: string }[];
  }[],
) {
  return entries.map((entry) => ({
    entry_type: entry.entryType,
    id: entry.id,
    // The entry's size is the debit side, not both sides added together —
    // the two are equal by construction. Micro-dollar amounts leave as
    // decimal strings: JSON's one number type loses integers above 2^53.
    total_micros: entry.postings
      .filter((posting) => posting.direction === "debit")
      .reduce((sum, posting) => sum + posting.amountMicros, 0n)
      .toString(),
  }));
}
