// In-flight AI spend, per account, so concurrent turns cannot each be
// admitted under a daily cap the others are about to spend.
//
// The daily cap (api-key.ts resolveAiAccess) compares what the ledger has
// recorded for today against the cap. A turn is metered when it ENDS, so
// while three turns run at once the ledger still says "nothing spent" and a
// fourth walks in under the same cap. This registry closes that window: a
// turn reserves an estimate the moment it is admitted, replaces the estimate
// with its priced running cost as its rounds complete, and releases it when
// it finishes. The admission gate counts `spent (ledger) + reserved (here)`.
//
// Scope: in-process memory, like turn-runner.ts — prod runs one auth-web
// instance, so every turn of an account lands in this map. A restart drops
// the reservations along with the turns they belonged to.

// What a turn reserves before it has spent anything. Deliberately a floor
// rather than a forecast: a typical scene-chat turn prices at a few cents,
// and reserving five means that under a $10 cap at most ~200 turns can be
// in flight before the gate refuses — comfortably more than the three
// concurrent turns the routes allow, while still stopping the cap from being
// overshot by a burst of turns admitted in the same second.
export const INITIAL_TURN_RESERVATION_MICROS = 50_000n;

type Reservation = { accountId: string; micros: bigint };

const reservations = new Map<string, Reservation>();

/** Reserve spend for a turn that was just admitted. Idempotent per turn. */
export function reserveTurnSpend(
  accountId: string,
  turnId: string,
  micros: bigint = INITIAL_TURN_RESERVATION_MICROS,
): void {
  reservations.set(turnId, { accountId, micros: micros < 0n ? 0n : micros });
}

/**
 * Replace a turn's reservation with what it has actually cost so far. The
 * initial floor stays in force until the priced cost exceeds it — a turn that
 * has priced one cheap round is still going to spend more.
 */
export function updateTurnSpend(turnId: string, pricedMicros: bigint): void {
  const current = reservations.get(turnId);
  if (!current) {
    return;
  }
  const floor = INITIAL_TURN_RESERVATION_MICROS;
  current.micros = pricedMicros > floor ? pricedMicros : floor;
}

/** The turn finished (however it finished): its spend is the ledger's now. */
export function releaseTurnSpend(turnId: string): void {
  reservations.delete(turnId);
}

/**
 * Everything the account's unfinished turns have reserved, optionally
 * excluding one turn (the caller's own, when it prices its own rounds).
 */
export function inFlightSpendMicros(
  accountId: string,
  excludeTurnId?: string,
): bigint {
  let total = 0n;
  for (const [turnId, reservation] of reservations) {
    if (reservation.accountId !== accountId || turnId === excludeTurnId) {
      continue;
    }
    total += reservation.micros;
  }
  return total;
}

// Test hook.
export function resetSpendReservationsForTests(): void {
  reservations.clear();
}
