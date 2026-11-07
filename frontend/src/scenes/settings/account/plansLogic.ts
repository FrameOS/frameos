import {
  MakeLogicType,
  actions,
  afterMount,
  beforeUnmount,
  connect,
  kea,
  listeners,
  path,
  reducers,
  selectors,
} from 'kea'
import { loaders } from 'kea-loaders'

import { apiFetch } from '../../../utils/apiFetch'
import { confirmDialog } from '../../../utils/confirmDialogLogic'
import { showErrorMessage } from '../../../utils/workingMessage'
import { apiCall, describeHttpError, readJsonPayload } from './api'
import { formatDate } from './format'
import { usageLogic } from './usageLogic'

// The Usage page's plan cards: Free, Private and Business from GET
// /api/account/plan (the cloud's plan-catalog.ts), where each card's price
// slider sits, and what its button does. A plan that can be bought goes to
// the payment provider's checkout; the others are activated by support, so
// their button writes to the support address.

export interface PlanStopLimits {
  backup_bytes: number
  cloud_rendered_frames: number
  frame_log_bytes: number
  frames: number
  people: number
  photo_bytes: number
  private_scene_bytes: number
}

export interface PlanStop {
  code: string
  current: boolean
  features: string[]
  limits: PlanStopLimits
  /** The features above that are not built yet. */
  planned_features?: string[]
  price_micros: string
  /** This account can take it at checkout. */
  purchasable?: boolean
}

export interface PlanGroup {
  available: boolean
  key: string
  name: string
  stops: PlanStop[]
}

export interface PlanCatalog {
  groups: PlanGroup[]
  /** Limit rows that count something not built yet. */
  planned_limits?: string[]
}

/** The payment provider's subscription for the account. */
export interface PlanSubscription {
  /** Set when a cancellation is scheduled: the plan ends here. */
  cancel_at: string | null
  /** The last charge failed and the provider is retrying the card. */
  past_due: boolean
  plan_code: string | null
  renews_at: string | null
  status: string
}

export interface PlanBilling {
  checkout: boolean
  /** The provider's billing page (invoices, the card) can be opened. */
  manage: boolean
  mode: 'live' | 'test' | null
  /** Prices are before tax, which checkout adds for the buyer's country. */
  prices_exclude_tax?: boolean
  subscription: PlanSubscription | null
}

/** Where the cards send someone who wants the long version. */
export interface PlanLinks {
  /** The public price list, with the reasoning behind it. */
  pricing: string
  refunds: string
}

export interface PlanResponse {
  billing: PlanBilling | null
  cancel_at: string | null
  catalog: PlanCatalog | null
  links: PlanLinks | null
  next_plan_code: string | null
}

/** What a card's button does. */
export type PlanCardAction =
  /** The account's plan. */
  | { kind: 'current' }
  /** The account's plan, with a cancellation scheduled: take it back. */
  | { kind: 'keep'; endsAt: string | null }
  /** Go to checkout. */
  | { kind: 'checkout' }
  /** Already paying: move to this stop. */
  | { kind: 'switch'; dearer: boolean }
  /** The Free card of a paying account. */
  | { kind: 'cancel' }
  /** The Free card once a cancellation is scheduled. */
  | { kind: 'ending'; endsAt: string | null }
  /** Activated by support. */
  | { kind: 'contact' }

export interface PlanCard {
  action: PlanCardAction
  /** Where to ask for this plan; null for Free, or with no support address. */
  contactHref: string | null
  current: boolean
  /** The slider's ends. */
  fromPriceMicros: string
  toPriceMicros: string
  /** What this stop has that the group before it does not ("Everything in Private", then these). */
  features: string[]
  group: PlanGroup
  /** Features a higher stop of this group adds, with the first price that has them. */
  laterFeatures: { feature: string; priceMicros: string }[]
  /** Of everything this card lists, what is not built yet. */
  plannedFeatures: string[]
  stop: PlanStop
  stopIndex: number
}

/** "$2", "$499": every catalog price is whole dollars. */
export function wholeDollars(micros: string): string {
  return `$${(BigInt(micros || '0') / 1_000_000n).toString()}`
}

function cardAction(stop: PlanStop, currentPriceMicros: bigint, billing: PlanBilling | null): PlanCardAction {
  const subscription = billing?.subscription ?? null
  const price = BigInt(stop.price_micros || '0')
  if (price === 0n) {
    if (stop.current) {
      return { kind: 'current' }
    }
    return subscription?.cancel_at ? { kind: 'ending', endsAt: subscription.cancel_at } : { kind: 'cancel' }
  }
  if (stop.current) {
    return subscription?.cancel_at ? { kind: 'keep', endsAt: subscription.cancel_at } : { kind: 'current' }
  }
  if (stop.purchasable && billing?.checkout) {
    return subscription ? { kind: 'switch', dearer: price > currentPriceMicros } : { kind: 'checkout' }
  }
  return { kind: 'contact' }
}

export function planCardsFor(
  catalog: PlanCatalog | null,
  stopIndexes: Record<string, number>,
  contactEmail: string | null,
  billing: PlanBilling | null = null
): PlanCard[] {
  const groups = catalog?.groups ?? []
  const currentStop = groups.flatMap((group) => group.stops).find((stop) => stop.current)
  const currentPriceMicros = BigInt(currentStop?.price_micros || '0')
  return groups.flatMap((group, groupIndex) => {
    const first = group.stops[0]
    const last = group.stops[group.stops.length - 1]
    if (!first || !last) {
      return []
    }
    const inherited = new Set(groups[groupIndex - 1]?.stops.flatMap((earlier) => earlier.features) ?? [])
    const currentIndex = group.stops.findIndex((stop) => stop.current)
    const wanted = stopIndexes[group.key] ?? (currentIndex >= 0 ? currentIndex : 0)
    const stopIndex = Math.min(Math.max(0, wanted), group.stops.length - 1)
    const stop = group.stops[stopIndex] ?? first
    const laterFeatures: PlanCard['laterFeatures'] = []
    for (const later of group.stops.slice(stopIndex + 1)) {
      for (const feature of later.features) {
        if (!stop.features.includes(feature) && !laterFeatures.some((entry) => entry.feature === feature)) {
          laterFeatures.push({ feature, priceMicros: later.price_micros })
        }
      }
    }
    const action = cardAction(stop, currentPriceMicros, billing)
    const subject = `Activate ${group.name} at ${wholeDollars(stop.price_micros)}/month`
    return {
      action,
      contactHref:
        action.kind !== 'contact' || !contactEmail
          ? null
          : `mailto:${contactEmail}?subject=${encodeURIComponent(subject)}`,
      current: stop.current,
      features: stop.features.filter((feature) => !inherited.has(feature)),
      fromPriceMicros: first.price_micros,
      group,
      laterFeatures,
      plannedFeatures: group.stops.flatMap((entry) => entry.planned_features ?? []),
      stop,
      stopIndex,
      toPriceMicros: last.price_micros,
    }
  })
}

/** How the return from checkout went (the `checkout` query parameter). */
export type CheckoutOutcome = 'active' | 'failed' | 'pending'

function readCheckoutOutcome(): CheckoutOutcome | null {
  if (typeof window === 'undefined') {
    return null
  }
  const url = new URL(window.location.href)
  const value = url.searchParams.get('checkout')
  if (value === 'canceled') {
    // Back from checkout without buying: nothing to say, nothing changed.
    url.searchParams.delete('checkout')
    window.history.replaceState(window.history.state, '', url.toString())
    return null
  }
  if (value !== 'active' && value !== 'failed' && value !== 'pending') {
    return null
  }
  // Read once: a reload should not thank them twice.
  url.searchParams.delete('checkout')
  window.history.replaceState(window.history.state, '', url.toString())
  return value
}

/** The server's own words for a refusal, when it sent any. */
async function describeFailure(response: Response): Promise<string> {
  const payload = await readJsonPayload(response)
  const detail = payload?.detail
  return typeof detail === 'string' && detail ? detail : describeHttpError(response.status)
}

// A plan paid for a moment ago may not be on the account yet. Look again a
// few times before telling them to come back later.
const pendingChecks = 6
const pendingCheckMs = 3000

// Generated by kea-typegen. Update if you're an agent, ignore if you're human.
export interface plansLogicValues {
  contactEmail: string | null // usageLogic
  billing: PlanBilling | null
  busy: string | null
  catalog: PlanCatalog | null
  catalogLoading: boolean
  checkoutOutcome: CheckoutOutcome | null
  links: PlanLinks | null
  pendingChecksLeft: number
  planCards: PlanCard[]
  planResponse: PlanResponse | null
  planResponseLoading: boolean
  stopIndexes: Record<string, number>
}

// Generated by kea-typegen. Update if you're an agent, ignore if you're human.
export interface plansLogicActions {
  loadUsage: () => any // usageLogic
  cancelPlan: () => {
    value: true
  }
  choosePlan: (code: string) => {
    code: string
  }
  keepPlan: (code: string) => {
    code: string
  }
  loadPlan: () => any
  loadPlanFailure: (
    error: string,
    errorObject?: any
  ) => {
    error: string
    errorObject?: any
  }
  loadPlanSuccess: (
    planResponse: {
      billing: PlanBilling | null
      cancel_at: string | null
      catalog: PlanCatalog | null
      links: PlanLinks | null
      next_plan_code: string | null
    },
    payload?: any
  ) => {
    planResponse: {
      billing: PlanBilling | null
      cancel_at: string | null
      catalog: PlanCatalog | null
      links: PlanLinks | null
      next_plan_code: string | null
    }
    payload?: any
  }
  openBilling: () => {
    value: true
  }
  planActionFinished: () => {
    value: true
  }
  setCheckoutOutcome: (outcome: CheckoutOutcome | null) => {
    outcome: CheckoutOutcome | null
  }
  setStopIndex: (
    group: string,
    index: number
  ) => {
    group: string
    index: number
  }
  switchPlan: (
    code: string,
    label: string,
    dearer: boolean
  ) => {
    code: string
    dearer: boolean
    label: string
  }
}

// Generated by kea-typegen. Update if you're an agent, ignore if you're human.
export interface plansLogicMeta {
  __keaTypeGenInternalSelectorTypes: {
    catalog: (planResponse: PlanResponse | null) => PlanCatalog | null
    billing: (planResponse: PlanResponse | null) => PlanBilling | null
    links: (planResponse: PlanResponse | null) => PlanLinks | null
    catalogLoading: (planResponseLoading: boolean) => boolean
    planCards: (
      catalog: PlanCatalog | null,
      stopIndexes: Record<string, number>,
      contactEmail: string | null,
      billing: PlanBilling | null
    ) => PlanCard[]
  }
}

export type plansLogicType = MakeLogicType<plansLogicValues, plansLogicActions, Record<string, any>> & plansLogicMeta

export const plansLogic = kea<plansLogicType>([
  path(['src', 'scenes', 'settings', 'account', 'plansLogic']),
  connect(() => ({
    values: [usageLogic, ['contactEmail']],
    actions: [usageLogic, ['loadUsage']],
  })),
  actions({
    setStopIndex: (group: string, index: number) => ({ group, index }),
    choosePlan: (code: string) => ({ code }),
    switchPlan: (code: string, label: string, dearer: boolean) => ({ code, label, dearer }),
    keepPlan: (code: string) => ({ code }),
    cancelPlan: true,
    openBilling: true,
    planActionFinished: true,
    setCheckoutOutcome: (outcome: CheckoutOutcome | null) => ({ outcome }),
  }),
  loaders(() => ({
    planResponse: [
      null as PlanResponse | null,
      {
        loadPlan: async () => {
          const response = await apiFetch('/api/account/plan')
          if (!response.ok) {
            throw new Error('Failed to load the plans')
          }
          const payload = (await response.json()) as Partial<PlanResponse>
          return {
            billing: payload.billing ?? null,
            cancel_at: payload.cancel_at ?? null,
            catalog: payload.catalog ?? null,
            links: payload.links ?? null,
            next_plan_code: payload.next_plan_code ?? null,
          }
        },
      },
    ],
  })),
  reducers({
    stopIndexes: [
      {} as Record<string, number>,
      {
        setStopIndex: (state, { group, index }) => ({ ...state, [group]: index }),
      },
    ],
    // The plan code (or "cancel" / "billing") whose button is working.
    busy: [
      null as string | null,
      {
        choosePlan: (_, { code }) => code,
        switchPlan: (_, { code }) => code,
        keepPlan: (_, { code }) => code,
        cancelPlan: () => 'cancel',
        openBilling: () => 'billing',
        planActionFinished: () => null,
      },
    ],
    checkoutOutcome: [
      null as CheckoutOutcome | null,
      {
        setCheckoutOutcome: (_, { outcome }) => outcome,
      },
    ],
    pendingChecksLeft: [
      0,
      {
        setCheckoutOutcome: (_, { outcome }) => (outcome === 'pending' ? pendingChecks : 0),
        loadPlanSuccess: (state) => Math.max(0, state - 1),
      },
    ],
  }),
  selectors({
    catalog: [
      (s) => [s.planResponse],
      (planResponse: PlanResponse | null): PlanCatalog | null => planResponse?.catalog ?? null,
    ],
    billing: [
      (s) => [s.planResponse],
      (planResponse: PlanResponse | null): PlanBilling | null => planResponse?.billing ?? null,
    ],
    links: [
      (s) => [s.planResponse],
      (planResponse: PlanResponse | null): PlanLinks | null => planResponse?.links ?? null,
    ],
    catalogLoading: [(s) => [s.planResponseLoading], (planResponseLoading: boolean): boolean => planResponseLoading],
    planCards: [
      (s) => [s.catalog, s.stopIndexes, s.contactEmail, s.billing],
      (
        catalog: PlanCatalog | null,
        stopIndexes: Record<string, number>,
        contactEmail: string | null,
        billing: PlanBilling | null
      ): PlanCard[] => planCardsFor(catalog, stopIndexes, contactEmail, billing),
    ],
  }),
  listeners(({ actions, values, cache }) => ({
    choosePlan: async ({ code }) => {
      const response = await apiCall('/api/account/plan/checkout', 'POST', { plan: code })
      const payload = response.ok ? await readJsonPayload(response) : undefined
      const url = payload?.checkout_url
      if (typeof url === 'string' && url) {
        // Stays busy: the page is leaving for checkout.
        window.location.assign(url)
        return
      }
      showErrorMessage(response.ok ? describeHttpError(502) : await describeFailure(response))
      actions.planActionFinished()
    },
    switchPlan: async ({ code, label, dearer }) => {
      try {
        const confirmed = await confirmDialog({
          title: `Switch to ${label}?`,
          message: dearer
            ? `${label} starts now. Your card is charged the difference for the rest of this billing period, and the new price from the next renewal.`
            : `You keep your current plan until the end of this billing period. ${label} and its price start at the next renewal.`,
          confirmLabel: `Switch to ${label}`,
        })
        if (!confirmed) {
          return
        }
        const response = await apiCall('/api/account/plan', 'PUT', { plan: code })
        if (response.status === 402) {
          // The bank wants the customer to confirm the charge (3-D Secure),
          // or declined it. Stripe holds the change until its invoice is
          // paid, on Stripe's own invoice page.
          const payload = await readJsonPayload(response)
          const url = payload?.url
          if (typeof url === 'string' && url) {
            const pay = await confirmDialog({
              title: 'Confirm the payment',
              message: `${
                typeof payload?.detail === 'string' ? payload.detail : 'Your bank needs to confirm this payment.'
              } Stripe opens the invoice for the change, and ${label} starts once it is paid.`,
              confirmLabel: 'Open the invoice',
            })
            if (pay) {
              window.location.assign(url)
            }
            actions.loadPlan()
            return
          }
          showErrorMessage(typeof payload?.detail === 'string' ? payload.detail : describeHttpError(402))
          return
        }
        if (!response.ok) {
          showErrorMessage(await describeFailure(response))
          return
        }
        actions.loadPlan()
        actions.loadUsage()
      } finally {
        actions.planActionFinished()
      }
    },
    keepPlan: async ({ code }) => {
      try {
        const response = await apiCall('/api/account/plan', 'PUT', { plan: code })
        if (!response.ok) {
          showErrorMessage(await describeFailure(response))
          return
        }
        actions.loadPlan()
      } finally {
        actions.planActionFinished()
      }
    },
    cancelPlan: async () => {
      try {
        const free = values.catalog?.groups.flatMap((group) => group.stops).find((stop) => stop.price_micros === '0')
        if (!free) {
          return
        }
        const renewsAt = values.billing?.subscription?.renews_at
        const confirmed = await confirmDialog({
          title: 'Cancel your plan?',
          message: renewsAt
            ? `You keep the plan until ${formatDate(
                renewsAt
              )} and are not charged again. After that the account is on Free. Nothing is deleted, but you cannot add frames or files above the Free limits.`
            : 'The account moves to Free. Nothing is deleted, but you cannot add frames or files above the Free limits.',
          confirmLabel: 'Cancel plan',
          cancelLabel: 'Keep plan',
          danger: true,
        })
        if (!confirmed) {
          return
        }
        const response = await apiCall('/api/account/plan', 'PUT', { plan: free.code })
        if (!response.ok) {
          showErrorMessage(await describeFailure(response))
          return
        }
        actions.loadPlan()
        actions.loadUsage()
      } finally {
        actions.planActionFinished()
      }
    },
    openBilling: async () => {
      const response = await apiCall('/api/account/plan/portal', 'POST')
      const payload = response.ok ? await readJsonPayload(response) : undefined
      const url = payload?.url
      if (typeof url === 'string' && url) {
        window.location.assign(url)
        return
      }
      showErrorMessage(response.ok ? describeHttpError(502) : await describeFailure(response))
      actions.planActionFinished()
    },
    loadPlanSuccess: () => {
      if (values.checkoutOutcome !== 'pending') {
        return
      }
      const paid = values.catalog?.groups
        .flatMap((group) => group.stops)
        .some((stop) => stop.current && stop.price_micros !== '0')
      if (paid) {
        actions.setCheckoutOutcome('active')
        actions.loadUsage()
      } else if (values.pendingChecksLeft > 0) {
        cache.pendingTimer = window.setTimeout(() => actions.loadPlan(), pendingCheckMs)
      }
    },
  })),
  afterMount(({ actions }) => {
    const outcome = readCheckoutOutcome()
    if (outcome) {
      actions.setCheckoutOutcome(outcome)
    }
    actions.loadPlan()
  }),
  beforeUnmount(({ cache }) => {
    window.clearTimeout(cache.pendingTimer)
  }),
])
