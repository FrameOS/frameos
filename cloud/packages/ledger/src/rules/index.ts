import type { PostingRuleRegistry } from "../types";
import { manualJournalEventType, manualJournalRule } from "./manual-journal";
import { reversalEventType, reversalRule } from "./reversal";

// Event type → the rule that knows what it means. Product code emits facts;
// this table is the whole of the translation into accounting, and adding a
// recipe (ai_usage, credit_purchase, psp_fee) is adding a line here.
export const postingRules: PostingRuleRegistry = {
  [manualJournalEventType]: manualJournalRule,
  [reversalEventType]: reversalRule,
};

export { manualJournalEventType, manualJournalRule } from "./manual-journal";
export { reversalEventType, reversalRule } from "./reversal";
