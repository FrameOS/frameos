// Double-entry accounting for FrameOS Cloud. Product code emits financial
// events; the kernel turns them into balanced, immutable journal entries
// through versioned posting rules; every balance and every report is a query
// over those postings. Design and reasoning: cloud/docs/accounting-todo.md.
export {
  accountBalanceFromPostings,
  accountBalanceMicros,
  availableCreditMicros,
} from "./balances";
export {
  customerCreditsCode,
  customerPromoCreditsCode,
  customerReceivableCode,
  describeAccountCode,
  ensureLedgerAccount,
  normalSideForType,
  systemAccountCodes,
  type LedgerAccountDefinition,
  type ResolvedLedgerAccount,
} from "./chart";
export {
  checkAccountingEquation,
  checkBalanceCache,
  checkCustomerCreditFloor,
  checkEntriesBalance,
  checkEventsPostedOnce,
  checkImmutabilityTriggers,
  checkLedgerIntegrity,
  checkReversalsMirror,
  type LedgerIntegrityOptions,
  type LedgerIntegrityViolation,
} from "./integrity";
export {
  findUnpostedEvents,
  postEvent,
  reverseEntry,
  validateDrafts,
  type PostEventOptions,
} from "./kernel";
export {
  dollarsToMicros,
  formatMicros,
  microsPerDollar,
  parseMicros,
} from "./money";
export {
  manualJournalEventType,
  manualJournalRule,
  postingRules,
  reversalEventType,
  reversalRule,
} from "./rules";
export {
  LedgerError,
  type EntryDraft,
  type FinancialEventInput,
  type FinancialEventRecord,
  type LedgerAccountType,
  type LedgerDb,
  type LedgerErrorCode,
  type LedgerExecutor,
  type LedgerTx,
  type PostEventResult,
  type PostedEntry,
  type PostedPosting,
  type PostingDirection,
  type PostingDraft,
  type PostingRule,
  type PostingRuleRegistry,
  type RuleContext,
} from "./types";
