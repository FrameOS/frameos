import { useActions, useValues } from 'kea'

import { Box } from '../../../components/Box'
import { Button } from '../../../components/Button'
import { Spinner } from '../../../components/Spinner'
import { Tag } from '../../../components/Tag'
import { AccountPageHeader, AccountSection, AccountTable } from './AccountPageHeader'
import { dollars, formatBytes, formatDateTime, surfaceLabel } from './format'
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
        FrameOS Cloud is in beta. While it is, everything is free: storage, frames and AI usage. Nothing is charged, and
        you will be told before that changes.
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
  const { usage, usageLoading, ai, aiLoading, contactEmail } = useValues(usageLogic)
  return (
    <div className="space-y-8">
      <AccountPageHeader page="usage" />
      <AccountSection title="Storage and frames">
        <Box className="p-4">{usage ? <StorageMeters usage={usage} /> : usageLoading ? <Spinner /> : null}</Box>
      </AccountSection>
      <AccountSection title="Need more?">
        <Box className="p-4 text-sm leading-relaxed">
          More storage, more frames, or a bigger daily AI allowance: tell us what you are building and we will sort it
          out.{' '}
          {contactEmail ? (
            <>
              Write to{' '}
              <a className="frameos-link hover:underline" href={`mailto:${contactEmail}`}>
                {contactEmail}
              </a>
              .
            </>
          ) : (
            'Contact us through the address in the footer.'
          )}
        </Box>
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
