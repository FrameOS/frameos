import { CheckIcon } from '@heroicons/react/24/outline'
import clsx from 'clsx'
import { useActions, useValues } from 'kea'

import { Box } from '../../../components/Box'
import { Button, buttonColor, buttonSize } from '../../../components/Button'
import { Spinner } from '../../../components/Spinner'
import { Tag } from '../../../components/Tag'
import { AccountPageHeader, AccountSection, AccountTable } from './AccountPageHeader'
import { dollars, formatBytes, formatDate, formatDateTime, surfaceLabel } from './format'
import { plansLogic, wholeDollars, type PlanBilling, type PlanCard, type PlanStopLimits } from './plansLogic'
import { usageLogic, type AccountUsage, type AiUsage, type AiUsageMonth } from './usageLogic'

interface Meter {
  label: string
  value: number
  max: number
  /** Frames are counted, not measured: same meter, different words on the right. */
  unit?: 'frames'
}

function meterValue(meter: Meter): string {
  return meter.unit === 'frames'
    ? `${meter.value} / ${meter.max}`
    : `${formatBytes(meter.value)} / ${formatBytes(meter.max)}`
}

// One capacity meter per quota bucket. The numbers next to each bar carry
// the exact state; the colour shift at 80%/95% is reinforcement, not the
// only signal. A 100 MB quota with 3 KB used rounds to 0%: keep a visible
// sliver so "there is something here" still reads.
function UsageMeter({ meter }: { meter: Meter }): JSX.Element {
  const percent = meter.max > 0 ? (meter.value / meter.max) * 100 : 0
  const width = meter.value > 0 ? `${Math.max(1.5, Math.min(100, percent))}%` : '0'
  const fill = percent >= 95 ? 'bg-red-500' : percent >= 80 ? 'bg-amber-500' : 'bg-[var(--frameos-primary)]'
  return (
    <div
      className="grid grid-cols-[8rem_1fr_auto] items-center gap-3 text-sm"
      title={`${meter.label}: ${meterValue(meter).replace(' / ', ' of ')}`}
    >
      <span className="frameos-muted">{meter.label}</span>
      <span className="h-2 overflow-hidden rounded-full bg-slate-500/15">
        <span className={`block h-full rounded-full ${fill}`} style={{ width }} />
      </span>
      <span className="frameos-strong tabular-nums">{meterValue(meter)}</span>
    </div>
  )
}

function StorageMeters({ usage }: { usage: AccountUsage }): JSX.Element {
  const totalBytes =
    usage.scenes.private_bytes +
    usage.scenes.public_bytes +
    usage.backups.bytes +
    usage.frame_logs.bytes +
    usage.photos.bytes
  const meters: Meter[] = [
    // First, because it is the quota people actually meet: storage is
    // generous, frames are a countable thing you add one at a time.
    { label: 'Frames', value: usage.frames.count, max: usage.frames.max_count, unit: 'frames' },
    // A pool of its own, shown once the plan has any (the free plan has
    // none) or the account still holds one from a plan it left.
    ...(usage.cloud_rendered_frames &&
    (usage.cloud_rendered_frames.max_count > 0 || usage.cloud_rendered_frames.count > 0)
      ? [
          {
            label: 'Virtual frames',
            value: usage.cloud_rendered_frames.count,
            max: usage.cloud_rendered_frames.max_count,
            unit: 'frames',
          } satisfies Meter,
        ]
      : []),
    { label: 'Private scenes', value: usage.scenes.private_bytes, max: usage.scenes.private_max_bytes },
    { label: 'Backups', value: usage.backups.bytes, max: usage.backups.max_bytes },
    { label: 'Frame logs', value: usage.frame_logs.bytes, max: usage.frame_logs.max_bytes },
    { label: 'Photos', value: usage.photos.bytes, max: usage.photos.max_bytes },
  ]
  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        {/* Named, because an unnamed limit reads as a bug the first time you
            meet it. Every limit is deployment-tunable, so a paid tier raises
            them without a code change. */}
        <span className="frameos-muted">{usage.plan.name} · storage used</span>
        <span className="frameos-strong font-semibold tabular-nums">{formatBytes(totalBytes)}</span>
      </div>
      {meters.map((meter) => (
        <UsageMeter key={meter.label} meter={meter} />
      ))}
      {usage.scenes.public_bytes > 0 ? (
        <div
          className="grid grid-cols-[8rem_1fr_auto] items-center gap-3 text-sm"
          title="Published public scenes don't count against any quota"
        >
          <span className="frameos-muted">Public scenes</span>
          <span />
          <span className="frameos-strong tabular-nums">{formatBytes(usage.scenes.public_bytes)} · free</span>
        </div>
      ) : null}
    </div>
  )
}

const planFeatureLabels: Record<string, string> = {
  share_frames: 'Share frames with the people on your plan',
  virtual_frames: 'Virtual frames: no hardware, shown on any screen through a link',
  sso: 'Single sign-on with SAML',
  priority_support: 'Priority support',
  dedicated_support: 'Dedicated support',
}

// What each card adds to the one before it, in front of its own features.
const planBaseFeatures: Record<string, string[]> = {
  free: [
    'Frames you own, from a Raspberry Pi to an ESP32',
    'The scene store and AI scene chat',
    'Photo albums and backups',
  ],
  private: ['Everything in Free'],
  business: ['Everything in Private'],
}

// A price list rolls over to GB at 1000 MB, so ten times 100 MB reads "1.0 GB".
function planBytes(bytes: number): string {
  const gigabyte = 1024 * 1024 * 1024
  return bytes >= 1000 * 1024 * 1024 && bytes < gigabyte ? `${(bytes / gigabyte).toFixed(1)} GB` : formatBytes(bytes)
}

interface PlanLimitRow {
  label: string
  value: string
  /** Counts something that is not built yet: shown, and marked. */
  planned: boolean
}

function planLimitRows(limits: PlanStopLimits, plannedLimits: string[]): PlanLimitRow[] {
  const count = (value: number): string => value.toLocaleString('en-US')
  const row = (label: string, value: string, key?: string): PlanLimitRow => ({
    label,
    value,
    planned: key !== undefined && plannedLimits.includes(key),
  })
  return [
    row('People', limits.people === 1 ? 'Just you' : count(limits.people), limits.people === 1 ? undefined : 'people'),
    row('Frames', count(limits.frames)),
    row(
      'Virtual frames',
      limits.cloud_rendered_frames === 0 ? 'None' : count(limits.cloud_rendered_frames),
      limits.cloud_rendered_frames === 0 ? undefined : 'cloud_rendered_frames'
    ),
    row('Photos', planBytes(limits.photo_bytes)),
    row('Private scenes', planBytes(limits.private_scene_bytes)),
    row('Backups', planBytes(limits.backup_bytes)),
    row('Frame logs', planBytes(limits.frame_log_bytes)),
  ]
}

function PlanFeature({ label, muted, planned }: { label: string; muted?: boolean; planned?: boolean }): JSX.Element {
  const faded = muted || planned
  return (
    <li className={clsx('flex gap-2', faded && 'frameos-muted')}>
      <CheckIcon className={clsx('mt-0.5 h-4 w-4 shrink-0', faded ? 'opacity-40' : 'text-[var(--frameos-primary)]')} />
      <span>
        {label}
        {planned ? ' (planned)' : ''}
      </span>
    </li>
  )
}

// A card's button: buy it, move to it, keep it, cancel, or write to support.
function PlanCardAction({ card }: { card: PlanCard }): JSX.Element | null {
  const { busy } = useValues(plansLogic)
  const { choosePlan, switchPlan, keepPlan, cancelPlan } = useActions(plansLogic)
  const { action, group, stop } = card
  const label = `${group.name} at ${wholeDollars(stop.price_micros)}/month`
  const working = busy !== null
  switch (action.kind) {
    case 'current':
      return (
        <Button color="secondary" full disabled>
          Your plan
        </Button>
      )
    case 'keep':
      return (
        <div className="space-y-2">
          <p className="frameos-muted text-center text-sm">
            {action.endsAt ? `Ends ${formatDate(action.endsAt)}` : 'Ends at the end of this billing period'}
          </p>
          <Button color="primary" full disabled={working} onClick={() => keepPlan(stop.code)}>
            {busy === stop.code ? 'Working…' : 'Keep this plan'}
          </Button>
        </div>
      )
    case 'checkout':
      return (
        <Button color="primary" full disabled={working} onClick={() => choosePlan(stop.code)}>
          {busy === stop.code ? 'Opening checkout…' : `Choose ${label}`}
        </Button>
      )
    case 'switch':
      return (
        <Button color="primary" full disabled={working} onClick={() => switchPlan(stop.code, label, action.dearer)}>
          {busy === stop.code ? 'Working…' : `Switch to ${wholeDollars(stop.price_micros)}/month`}
        </Button>
      )
    case 'cancel':
      return (
        <Button color="secondary" full disabled={working} onClick={() => cancelPlan()}>
          {busy === 'cancel' ? 'Working…' : 'Cancel my paid plan'}
        </Button>
      )
    case 'ending':
      return (
        <p className="frameos-muted text-center text-sm">
          {action.endsAt ? `Your account moves here on ${formatDate(action.endsAt)}` : 'Your account moves here soon'}
        </p>
      )
    case 'contact':
      return card.contactHref ? (
        <a className={clsx(buttonSize('normal'), buttonColor('primary'), 'block w-full')} href={card.contactHref}>
          Contact support to activate
        </a>
      ) : (
        <p className="frameos-muted text-center text-sm">Contact support to activate</p>
      )
  }
}

function PlanCardBox({ card, plannedLimits }: { card: PlanCard; plannedLimits: string[] }): JSX.Element {
  const { setStopIndex } = useActions(plansLogic)
  const { group, stop, stopIndex } = card
  const sliding = group.stops.length > 1
  return (
    <Box
      className="flex flex-col gap-4 p-5"
      // Inline: the card theme sets its own border color, which a class here would lose to.
      style={card.current ? { borderColor: 'var(--frameos-primary)' } : undefined}
      data-plan={group.key}
    >
      <div>
        <div className="flex items-center justify-between gap-2">
          <h3 className="frameos-strong text-lg font-semibold">{group.name}</h3>
          {card.current ? <Tag color="teal">Current plan</Tag> : null}
        </div>
        <p className="frameos-muted text-sm">
          {sliding ? `From ${wholeDollars(card.fromPriceMicros)}/month` : 'For the frames you own'}
        </p>
      </div>
      <div>
        <div className="flex items-baseline gap-1">
          <span className="frameos-strong text-3xl font-bold tabular-nums">{wholeDollars(stop.price_micros)}</span>
          <span className="frameos-muted text-sm">/month</span>
        </div>
        {sliding ? (
          <div className="mt-2">
            <input
              type="range"
              min={0}
              max={group.stops.length - 1}
              step={1}
              value={stopIndex}
              onChange={(event) => setStopIndex(group.key, Number(event.target.value))}
              aria-label={`${group.name} price`}
              aria-valuetext={`${wholeDollars(stop.price_micros)} a month`}
              className="w-full accent-[var(--frameos-primary)]"
            />
            <div className="frameos-muted flex justify-between text-xs tabular-nums">
              <span>{wholeDollars(card.fromPriceMicros)}</span>
              <span>{wholeDollars(card.toPriceMicros)}</span>
            </div>
          </div>
        ) : (
          <div className="mt-2 h-10" aria-hidden="true" />
        )}
      </div>
      <dl className="space-y-1.5 text-sm">
        {planLimitRows(stop.limits, plannedLimits).map(({ label, value, planned }) => (
          <div key={label} className="flex justify-between gap-3">
            <dt className="frameos-muted">{label}</dt>
            <dd className={clsx('tabular-nums', planned ? 'frameos-muted' : 'frameos-strong')}>
              {value}
              {planned ? ' (planned)' : ''}
            </dd>
          </div>
        ))}
      </dl>
      <ul className="space-y-1.5 text-sm">
        {(planBaseFeatures[group.key] ?? []).map((label) => (
          <PlanFeature key={label} label={label} />
        ))}
        {card.features.map((feature) => (
          <PlanFeature
            key={feature}
            label={planFeatureLabels[feature] ?? feature}
            planned={card.plannedFeatures.includes(feature)}
          />
        ))}
        {card.laterFeatures.map(({ feature, priceMicros }) => (
          <PlanFeature
            key={feature}
            label={`${planFeatureLabels[feature] ?? feature} at ${wholeDollars(priceMicros)}/month`}
            muted
          />
        ))}
      </ul>
      <div className="mt-auto pt-2">
        <PlanCardAction card={card} />
      </div>
    </Box>
  )
}

// What the payment provider holds for the account: when the plan renews or
// ends, a failed payment, and the way to its billing page.
function BillingStatus({ billing }: { billing: PlanBilling }): JSX.Element | null {
  const { busy, checkoutOutcome } = useValues(plansLogic)
  const { openBilling } = useActions(plansLogic)
  const { subscription } = billing
  const lines: { text: string; warning?: boolean }[] = []
  if (checkoutOutcome === 'active') {
    lines.push({ text: 'Thank you. Your plan is active.' })
  } else if (checkoutOutcome === 'pending') {
    lines.push({ text: 'Thank you. Your payment is being confirmed. This usually takes a few seconds.' })
  } else if (checkoutOutcome === 'failed') {
    lines.push({ text: 'That checkout could not be matched to this account. Nothing changed here.', warning: true })
  }
  if (subscription?.past_due) {
    lines.push({
      text: 'Your last payment failed. Update your card under Manage billing to keep the plan.',
      warning: true,
    })
  } else if (subscription?.cancel_at) {
    lines.push({ text: `Your plan is cancelled and runs until ${formatDate(subscription.cancel_at)}.` })
  } else if (subscription?.renews_at) {
    lines.push({ text: `Your plan renews on ${formatDate(subscription.renews_at)}.` })
  }
  if (billing.mode === 'test' && billing.checkout) {
    lines.push({ text: 'Payments are in test mode. Checkout takes test cards only and nothing is charged.' })
  }
  if (lines.length === 0 && !billing.manage) {
    return null
  }
  return (
    <Box className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm" data-billing-status>
      <div className="space-y-1">
        {lines.map(({ text, warning }) => (
          <p key={text} className={warning ? 'text-amber-600' : undefined} role={warning ? 'alert' : undefined}>
            {text}
          </p>
        ))}
        {lines.length === 0 ? <p className="frameos-muted">Invoices and your card are on the billing page.</p> : null}
      </div>
      {billing.manage ? (
        <Button color="secondary" size="small" disabled={busy !== null} onClick={() => openBilling()}>
          {busy === 'billing' ? 'Opening…' : 'Manage billing'}
        </Button>
      ) : null}
    </Box>
  )
}

function PlanCards(): JSX.Element {
  const { planCards, catalog, catalogLoading, billing, contactEmail, links } = useValues(plansLogic)
  if (planCards.length === 0) {
    return catalogLoading ? <Spinner /> : <></>
  }
  const plannedLimits = catalog?.planned_limits ?? []
  const anyPlanned = plannedLimits.length > 0 || planCards.some((card) => card.plannedFeatures.length > 0)
  return (
    <div className="space-y-3">
      <p className="text-sm leading-relaxed">
        FrameOS is free and open source, and the Free plan is meant to be all a household needs. A paid plan holds more
        frames and more files. It pays for the hosting, and it is how you support a bootstrapped project.
        {links ? (
          <>
            {' '}
            <a className="frameos-link hover:underline" href={links.pricing} target="_blank" rel="noreferrer">
              More about pricing
            </a>
            .
          </>
        ) : null}
      </p>
      {billing ? <BillingStatus billing={billing} /> : null}
      <div className="grid gap-4 lg:grid-cols-3">
        {planCards.map((card) => (
          <PlanCardBox key={card.group.key} card={card} plannedLimits={plannedLimits} />
        ))}
      </div>
      <p className="frameos-muted text-sm leading-relaxed">
        Paid plans are billed monthly and can be cancelled at any time. Prices are in US dollars and exclude VAT or
        sales tax, which is added at checkout where it applies. AI is priced per request and costs the same on every
        plan.
        {anyPlanned ? ' Anything marked planned is not available yet and is not part of what you pay for today.' : ''}
        {links ? (
          <>
            {' '}
            A first payment is refunded in full if you ask within 14 days. See the{' '}
            <a className="frameos-link hover:underline" href={links.refunds} target="_blank" rel="noreferrer">
              refund policy
            </a>
            .
          </>
        ) : null}
        {contactEmail ? (
          <>
            {' '}
            Questions? Write to{' '}
            <a className="frameos-link hover:underline" href={`mailto:${contactEmail}`}>
              {contactEmail}
            </a>
            .
          </>
        ) : null}
      </p>
    </div>
  )
}

// Surfaces the platform pays for on purpose, whoever's key ran them.
const freeSurfaces = new Set(['scene_convert', 'store_classify', 'store_recategorize'])

// One row per surface: own-key vs our-key is a real distinction to the
// books and none at all to somebody reading their own usage, so it is
// summed away here.
function collapseBySurface(month: AiUsageMonth): { micros: bigint; surface: string | null; turns: number }[] {
  const bySurface = new Map<string | null, { micros: bigint; surface: string | null; turns: number }>()
  for (const bucket of month.surfaces) {
    const existing = bySurface.get(bucket.surface)
    const micros = BigInt(bucket.micros || '0')
    if (existing) {
      existing.micros += micros
      existing.turns += bucket.turns
    } else {
      bySurface.set(bucket.surface, { micros, surface: bucket.surface, turns: bucket.turns })
    }
  }
  return [...bySurface.values()].sort((a, b) =>
    a.micros === b.micros ? b.turns - a.turns : b.micros > a.micros ? 1 : -1
  )
}

function AiUsageCard({ ai }: { ai: AiUsage }): JSX.Element {
  const { togglingAi } = useValues(usageLogic)
  const { setAiEnabled } = useActions(usageLogic)
  const thisMonth = ai.months.current
  const lastMonth = ai.months.previous
  const owed = BigInt(ai.balance.receivable_micros || '0')
  const lines = ai.balance.recent_lines ?? []
  const billable = BigInt(thisMonth.micros || '0') > 0n && !thisMonth.own_key_only
  // Billed only when metering is live AND something in the month was
  // actually billable to them: a month spent entirely on the operator's
  // shared key or on absorbed surfaces owes nothing, and "this is billed at
  // the end of the month" over that number would be a bill-shaped lie.
  const billed = ai.metering_mode === 'live' && billable
  const showBalance = ai.metering_mode === 'live' || owed !== 0n || lines.length > 0

  return (
    <Box className="space-y-4 p-4" id="ai">
      {!ai.enabled ? (
        <p className="text-sm leading-relaxed">
          AI features are switched off for this account, so nothing is being used and nothing can be charged.
        </p>
      ) : (
        <p className="text-sm leading-relaxed">
          You have used <strong>{dollars(thisMonth.micros)}</strong> of AI this month across {thisMonth.turns}{' '}
          {thisMonth.turns === 1 ? 'request' : 'requests'}.{' '}
          {billed
            ? 'This is billed at the end of the month.'
            : 'Nothing is billed: every request is currently free to you.'}
          {lastMonth.turns > 0 ? ` Last month it was ${dollars(lastMonth.micros)}.` : null}
        </p>
      )}
      {thisMonth.own_key_only && thisMonth.turns > 0 ? (
        <p className="frameos-muted text-sm leading-relaxed">
          Every request this month ran on your own OpenAI key, so you owe us nothing for it. The figure above is what
          those tokens cost at OpenAI's list price, for your own reference.
        </p>
      ) : null}

      {showBalance ? (
        <div className="space-y-2">
          <h3 className="frameos-strong font-semibold">Your balance</h3>
          <p className="text-sm leading-relaxed">
            {owed > 0n
              ? `You currently owe ${dollars(
                  owed
                )}. That is what the month-end invoice collects: metered usage, any plan fee, less any credit.`
              : owed < 0n
              ? `You have a credit of ${dollars(-owed)} in your favour, which nets against future usage.`
              : 'Nothing is owed right now.'}
          </p>
          {lines.length > 0 ? (
            <AccountTable head={['When', 'What', 'Amount']}>
              {lines.map((line) => (
                <tr key={line.id}>
                  <td className="py-2 pr-3">{formatDateTime(line.occurred_at)}</td>
                  <td className="py-2 pr-3">{line.description}</td>
                  <td className="py-2 text-right tabular-nums">
                    {line.direction === 'debit' ? '' : '-'}
                    {dollars(line.amount_micros)}
                  </td>
                </tr>
              ))}
            </AccountTable>
          ) : null}
        </div>
      ) : null}

      <details className="group">
        <summary className="frameos-strong cursor-pointer font-semibold">Where it went</summary>
        <div className="mt-2 space-y-2">
          {thisMonth.surfaces.length === 0 ? (
            <p className="frameos-muted text-sm">No AI requests yet this month.</p>
          ) : (
            <AccountTable head={['Feature', 'Requests', 'This month']}>
              {collapseBySurface(thisMonth).map((row) => (
                <tr key={row.surface ?? 'other'}>
                  <td className="py-2 pr-3">
                    {surfaceLabel(row.surface)}
                    {freeSurfaces.has(row.surface ?? '') ? (
                      <Tag className="ml-2" color="teal">
                        free
                      </Tag>
                    ) : null}
                  </td>
                  <td className="py-2 pr-3">{row.turns}</td>
                  <td className="py-2 text-right tabular-nums">{dollars(row.micros)}</td>
                </tr>
              ))}
            </AccountTable>
          )}
          <p className="frameos-muted text-xs">The scene converter and store classification are always on us.</p>
        </div>
      </details>

      <details className="group">
        <summary className="frameos-strong cursor-pointer font-semibold">Recent requests</summary>
        <div className="mt-2">
          {ai.turns.length === 0 ? (
            <p className="frameos-muted text-sm">Nothing yet.</p>
          ) : (
            <AccountTable head={['When', 'Feature', 'Model', 'Cost']}>
              {ai.turns.map((turn, index) => (
                <tr key={`${turn.occurred_at}-${index}`}>
                  <td className="py-2 pr-3">{formatDateTime(turn.occurred_at)}</td>
                  <td className="py-2 pr-3">{surfaceLabel(turn.surface)}</td>
                  <td className="frameos-muted py-2 pr-3">{turn.model}</td>
                  <td className="py-2 text-right tabular-nums">
                    {turn.own_key ? 'your key' : turn.credited ? 'credited' : dollars(turn.micros)}
                  </td>
                </tr>
              ))}
            </AccountTable>
          )}
        </div>
      </details>

      {/* The AI opt-out: it says what stops working before it stops it. */}
      <div className="space-y-2">
        <Button size="small" color="secondary" disabled={togglingAi} onClick={() => setAiEnabled(!ai.enabled)}>
          {ai.enabled ? 'Turn AI features off' : 'Turn AI features back on'}
        </Button>
        <p className="frameos-muted text-sm leading-relaxed">
          {ai.enabled
            ? 'AI is on. Turning it off stops scene chat and the app-code assistant for this account, takes effect immediately, and guarantees no further AI cost.'
            : 'AI is off for this account. Nothing you do can incur AI cost. Your scenes, frames and backups are unaffected.'}
        </p>
      </div>
    </Box>
  )
}

function PricingCard({ ai }: { ai: AiUsage }): JSX.Element {
  const sharedKey = ai.cap.allowance === 'shared'
  return (
    <Box className="space-y-3 p-4 text-sm leading-relaxed">
      <p>
        The Free plan costs nothing, and while FrameOS Cloud is in beta neither does AI usage. A paid plan is billed
        monthly in advance, and you can cancel it at any time.
      </p>
      <p>
        Once billing starts, AI usage will be priced per request: what the model provider charges for the tokens it
        used, plus our margin. The token counts and unit prices behind every request are kept, so each number on this
        page can be checked.
      </p>
      <p>
        You are on the <strong>{ai.plan.name}</strong> plan
        {ai.plan.next_plan_code ? ` (moving to ${ai.plan.next_plan_code} at the next renewal)` : ''}
        {ai.plan.cancel_at ? ` (ends ${formatDateTime(ai.plan.cancel_at)})` : ''}.
        {BigInt(ai.plan.price_micros || '0') > 0n
          ? ' The plan fee is billed at the start of each period, AI usage at the end of the month.'
          : ''}{' '}
        {sharedKey
          ? `Your requests run on our shared OpenAI key, with a daily allowance of ${dollars(
              ai.cap.daily_micros
            )}. Today you have used ${dollars(ai.cap.today_micros)} of it, and it resets at ${formatDateTime(
              ai.cap.resets_at
            )}. Add your own OpenAI key under Service keys to use AI without the allowance.`
          : `A daily limit of ${dollars(
              ai.cap.daily_micros
            )} applies, so a runaway loop can only cost a bounded amount. Today you have used ${dollars(
              ai.cap.today_micros
            )}, and it resets at ${formatDateTime(ai.cap.resets_at)}.`}
      </p>
    </Box>
  )
}

// Everything the account uses, on one page: the storage and frame quotas
// and where to ask for more, then AI usage with its switch and how pricing
// works. Every number comes from the same accountUsage() the quota refusals
// read.
export function UsagePage(): JSX.Element {
  const { usage, usageLoading, ai, aiLoading } = useValues(usageLogic)
  return (
    <div className="space-y-8">
      <AccountPageHeader page="usage" />
      <AccountSection title="Storage and frames">
        <Box className="p-4">{usage ? <StorageMeters usage={usage} /> : usageLoading ? <Spinner /> : null}</Box>
      </AccountSection>
      <AccountSection title="Need more?">
        <PlanCards />
      </AccountSection>
      <AccountSection title="AI usage">{ai ? <AiUsageCard ai={ai} /> : aiLoading ? <Spinner /> : null}</AccountSection>
      {ai ? (
        <AccountSection title="How pricing works">
          <PricingCard ai={ai} />
        </AccountSection>
      ) : null}
    </div>
  )
}
