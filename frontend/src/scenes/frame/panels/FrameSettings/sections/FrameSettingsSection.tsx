import type { ReactNode } from 'react'
import clsx from 'clsx'
import { H6 } from '../../../../../components/H6'
import { useFrameSettings } from '../frameSettingsContext'
import { frameSettingsSectionRenders } from '../frameSettingsSurface'

/**
 * One section of the Settings panel, gated by frameSettingsSurface.ts.
 *
 * `sectionKey` is the row in that table; a section whose row does not list the
 * current surface renders nothing. This is the panel's ONLY surface gate — no
 * section may test `workspaceMode()`, `isCloudMode()` or the profile flags for
 * itself, because a condition written inline is a condition nobody reviews.
 * Everything else (which panel is attached, what firmware the device
 * reported, whether the frame is embedded) stays local to the section.
 */
/**
 * The same gate as a hook, for the few places that wrap several sections in
 * one <fieldset> (a firmware floor disables the whole batch at once): the
 * wrapper itself has to disappear with them, and it must ask the table rather
 * than test the surface by hand.
 */
export function useFrameSettingsSectionRenders(sectionKey: string): boolean {
  const { surface } = useFrameSettings()
  return frameSettingsSectionRenders(sectionKey, surface)
}

export function FrameSettingsSection({
  sectionKey,
  children,
}: {
  sectionKey: string
  children: ReactNode
}): JSX.Element | null {
  const { surface } = useFrameSettings()
  if (!frameSettingsSectionRenders(sectionKey, surface)) {
    return null
  }
  return <>{children}</>
}

/**
 * The heading a section opens with. `action` is the frame dropdown on the
 * sections that carry it.
 */
export function SectionHeading({
  id,
  action,
  row,
  className,
  children,
}: {
  id?: string
  /**
   * Rendered to the right of the heading. A slot that renders nothing (the
   * dropdown is hidden) still keeps the row wrapper, so the spacing does not
   * move with it.
   */
  action?: ReactNode
  /** Force the heading-row wrapper on a heading that carries no action. */
  row?: boolean
  className?: string
  children: ReactNode
}): JSX.Element {
  if (action === undefined && !row) {
    return (
      <H6 id={id} className={className}>
        {children}
      </H6>
    )
  }
  return (
    <div className={clsx('frame-settings-heading-row', className ?? 'mt-2', 'flex items-center justify-between gap-3')}>
      <H6 id={id}>{children}</H6>
      {action}
    </div>
  )
}

/** The indented body every section shares. */
export function SectionBody({ className, children }: { className?: string; children: ReactNode }): JSX.Element {
  return <div className={clsx('pl-2 @md:pl-8', className ?? 'space-y-2')}>{children}</div>
}
