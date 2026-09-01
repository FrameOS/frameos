import type { PostingRuleRegistry } from "../types";
import { aiUsageEventType, aiUsageRule } from "./ai-usage";
import { manualJournalEventType, manualJournalRule } from "./manual-journal";
import {
  reclassificationEventType,
  reclassificationRule,
} from "./reclassification";
import { reversalEventType, reversalRule } from "./reversal";
import {
  subscriptionChargeEventType,
  subscriptionChargeRule,
  subscriptionRecognitionEventType,
  subscriptionRecognitionRule,
  subscriptionRefundEventType,
  subscriptionRefundRule,
} from "./subscription";

// Event type → the rule that knows what it means. Product code emits facts;
// this table is the whole of the translation into accounting, and adding a
// recipe (credit_purchase, psp_fee, subscription_charge) is adding a line
// here.
export const postingRules: PostingRuleRegistry = {
  [aiUsageEventType]: aiUsageRule,
  [manualJournalEventType]: manualJournalRule,
  [reclassificationEventType]: reclassificationRule,
  [reversalEventType]: reversalRule,
  [subscriptionChargeEventType]: subscriptionChargeRule,
  [subscriptionRecognitionEventType]: subscriptionRecognitionRule,
  [subscriptionRefundEventType]: subscriptionRefundRule,
};

export { aiUsageEventType, aiUsageRule } from "./ai-usage";
export { manualJournalEventType, manualJournalRule } from "./manual-journal";
export {
  reclassificationEventType,
  reclassificationRule,
} from "./reclassification";
export { reversalEventType, reversalRule } from "./reversal";
export {
  subscriptionChargeEventType,
  subscriptionChargeRule,
  subscriptionRecognitionEventType,
  subscriptionRecognitionRule,
  subscriptionRefundEventType,
  subscriptionRefundRule,
} from "./subscription";
