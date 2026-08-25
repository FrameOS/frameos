import { afterMount, beforeUnmount, getPluginContext } from 'kea'
import type { BuiltLogic, Logic, LogicBuilder } from 'kea'
import { subscriptions as keaSubscriptions, type Subscription } from 'kea-subscriptions'

interface RecordedSubscription {
  logic: { pathString: string }
}

// kea-subscriptions keeps each subscription in a closure of the built logic
// object and drops it in that object's beforeUnmount, while kea counts
// mounts per path. React can re-mount a built logic object kea has already
// dropped from its cache (StrictMode's effect replay, Fast Refresh): from
// then on two objects share one path, afterMount ran on the old one and
// beforeUnmount runs on the new one — the old object's subscriptions outlive
// the logic. When a fresh instance later attaches the same path, they fire
// against ITS state with THEIR stale lastValue. That is how the diagram's
// `edges` subscription wrote `[]` into the frame form after a scene was
// swapped out and back in (v4 → v5 in the store workspace: no edges).
//
// The same subscriptions, with every subscription registered under the
// logic's path purged before its own are added and again when it unmounts.
export function subscriptions<L extends Logic = Logic, I = Partial<Record<keyof L['values'], Subscription>>>(
  input: I | ((logic: BuiltLogic<L>) => I)
): LogicBuilder<L> {
  return (logic: BuiltLogic<L>) => {
    const purge = (): void => {
      const registered = getPluginContext<{ subscriptions: Set<RecordedSubscription> }>('subscriptions').subscriptions
      for (const subscription of Array.from(registered)) {
        if (subscription.logic.pathString === logic.pathString) {
          registered.delete(subscription)
        }
      }
    }
    afterMount(purge)(logic)
    keaSubscriptions<L, I>(input)(logic)
    beforeUnmount(purge)(logic)
  }
}
