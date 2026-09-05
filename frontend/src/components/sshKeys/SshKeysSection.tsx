import { PlusIcon, TrashIcon } from '@heroicons/react/24/outline'
import clsx from 'clsx'
import { useActions, useValues } from 'kea'
import { useEffect, useRef } from 'react'
import type { ReactElement, ReactNode } from 'react'

import { describeSshPublicKey } from '../../utils/sshKeys'
import { Button } from '../Button'
import { Switch } from '../Switch'
import { Tag } from '../Tag'
import { AddSshKeyModal } from './AddSshKeyModal'
import { sshKeysLogic } from './sshKeysLogic'

export interface SshKeysSectionProps {
  /**
   * When given, every key gets a switch and the list is a selection (which
   * keys go on this frame / this SD card). Without it the list only manages
   * the keys themselves.
   */
  selectedIds?: string[] | undefined
  onSelectionChange?: ((ids: string[]) => void) | undefined
  /** Shown above the list; the empty state falls back to a generic hint. */
  description?: ReactNode
  /** Tighter spacing for the SD card builders. */
  compact?: boolean | undefined
  /** Hide the per-key delete button (e.g. a list that only picks keys). */
  hideRemove?: boolean | undefined
  className?: string | undefined
}

// The one SSH key list: the account's (cloud) or backend's keys with an
// "Add SSH key" button that opens the modal. Drawn by the SD card builders
// (cloud and self-hosted), the frame settings panel and the settings page.
export function SshKeysSection({
  selectedIds,
  onSelectionChange,
  description,
  compact,
  hideRemove,
  className,
}: SshKeysSectionProps): ReactElement {
  const { keys, lastAddedKeyId } = useValues(sshKeysLogic)
  const { openAddKeyModal, removeKey } = useActions(sshKeysLogic)
  const selectable = !!onSelectionChange
  const selected = new Set(selectedIds ?? [])

  // A key added from this list is meant for this frame: tick it.
  const seenAddedKeyId = useRef<string | null>(lastAddedKeyId)
  useEffect(() => {
    if (lastAddedKeyId && lastAddedKeyId !== seenAddedKeyId.current) {
      seenAddedKeyId.current = lastAddedKeyId
      if (onSelectionChange && !selected.has(lastAddedKeyId)) {
        onSelectionChange([...(selectedIds ?? []), lastAddedKeyId])
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastAddedKeyId])

  return (
    <div className={clsx('min-w-0 space-y-2', className)}>
      {description ? <div className="frameos-muted text-xs leading-relaxed">{description}</div> : null}
      {keys.length === 0 ? (
        <div className="frameos-muted text-sm">
          No SSH keys yet. Add one to be able to log in to the frame over SSH.
        </div>
      ) : (
        <ul className={clsx('frame-tool-panel min-w-0', compact ? 'space-y-1' : 'space-y-2')} aria-label="SSH keys">
          {keys.map((key) => {
            const label = key.name || key.id
            return (
              <li key={key.id} className="flex min-w-0 items-center gap-2">
                {selectable ? (
                  <Switch
                    aria-label={`Install ${label}`}
                    value={selected.has(key.id)}
                    onChange={(value) => {
                      const next = new Set(selected)
                      if (value) {
                        next.add(key.id)
                      } else {
                        next.delete(key.id)
                      }
                      onSelectionChange?.(keys.filter((entry) => next.has(entry.id)).map((entry) => entry.id))
                    }}
                  />
                ) : null}
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="frameos-strong truncate text-sm font-semibold">{label}</span>
                    {key.use_for_new_frames ? (
                      <Tag color="primary" className="text-[10px]">
                        Default on new frames
                      </Tag>
                    ) : null}
                  </div>
                  <div className="frameos-muted truncate font-mono text-xs">{describeSshPublicKey(key.public)}</div>
                </div>
                {!hideRemove ? (
                  <Button
                    type="button"
                    size="tiny"
                    color="secondary"
                    aria-label={`Remove ${label}`}
                    title="Remove this key"
                    onClick={() => {
                      if (window.confirm(`Remove the SSH key "${label}"? Frames it is already installed on keep it.`)) {
                        removeKey(key.id)
                      }
                    }}
                  >
                    <TrashIcon className="h-4 w-4" />
                  </Button>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
      <div>
        <Button
          type="button"
          size="small"
          color="secondary"
          onClick={openAddKeyModal}
          className="inline-flex items-center gap-1"
        >
          <PlusIcon className="h-4 w-4" />
          Add SSH key
        </Button>
      </div>
      <AddSshKeyModal />
    </div>
  )
}
