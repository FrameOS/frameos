import { useActions, useValues } from 'kea'
import { ArrowDownTrayIcon } from '@heroicons/react/24/outline'

import { Box } from '../../../components/Box'
import { Button } from '../../../components/Button'
import { Select } from '../../../components/Select'
import { Spinner } from '../../../components/Spinner'
import { TextInput } from '../../../components/TextInput'
import { AccountPageHeader, AccountTable } from './AccountPageHeader'
import { backupLabel, backupsLogic, type BackupKindFilter } from './backupsLogic'
import { formatBytes, formatDateTime } from './format'

export function BackupsPage(): JSX.Element {
  const { listing, listingLoading, filteredBackups, filtered, query, kind, deletingId, totalBytes } =
    useValues(backupsLogic)
  const { setQuery, setKind, clearFilters, deleteBackup } = useActions(backupsLogic)

  return (
    <div className="space-y-4">
      <AccountPageHeader page="backups" />
      {listing.backups.length > 0 ? (
        <p className="frameos-muted text-sm">
          Backups belong to this account: a reinstalled backend that links again and imports your backup recovery key
          can restore them. Using {listing.backups.length} of {listing.max_backups} items, {formatBytes(totalBytes)}{' '}
          total.
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <TextInput
          aria-label="Search backups"
          className="min-w-[14rem] flex-1"
          placeholder="Search name, key, or device…"
          type="search"
          value={query}
          onChange={(value) => setQuery(value)}
        />
        <div className="w-40">
          <Select
            aria-label="Kind"
            value={kind}
            onChange={(value) => setKind(value as BackupKindFilter)}
            options={[
              { value: '', label: 'All kinds' },
              { value: 'frames', label: 'Frames' },
              { value: 'templates', label: 'Scenes' },
            ]}
          />
        </div>
        {filtered ? (
          <Button size="small" color="secondary" onClick={clearFilters}>
            Clear
          </Button>
        ) : null}
      </div>
      {listingLoading && listing.backups.length === 0 ? (
        <Spinner />
      ) : filteredBackups.length > 0 ? (
        <Box className="p-4">
          <AccountTable head={['Name', 'Kind', 'Size', 'Sent by', 'Updated', '']}>
            {filteredBackups.map((backup) => {
              const label = backupLabel(backup)
              return (
                <tr key={backup.id}>
                  <td className="py-2 pr-3 align-top">
                    <div className="frameos-strong font-medium">{label}</div>
                    {backup.name && backup.name !== backup.item_key ? (
                      <div className="frameos-muted font-mono text-xs">{backup.item_key}</div>
                    ) : null}
                  </td>
                  <td className="py-2 pr-3 align-top">{backup.kind_label}</td>
                  <td className="py-2 pr-3 align-top">{formatBytes(backup.size_bytes)}</td>
                  <td className="py-2 pr-3 align-top">{backup.pushed_by ?? 'Unlinked device'}</td>
                  <td className="py-2 pr-3 align-top">{formatDateTime(backup.updated_at)}</td>
                  <td className="py-2 align-top">
                    <div className="flex items-center justify-end gap-1">
                      <a
                        className="frameos-button frameos-secondary-button inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm"
                        href={backup.download_url}
                      >
                        <ArrowDownTrayIcon className="h-4 w-4" />
                        Download
                      </a>
                      <Button
                        size="small"
                        color="red"
                        disabled={deletingId === backup.id}
                        onClick={() => deleteBackup(backup.id)}
                      >
                        {deletingId === backup.id ? 'Deleting…' : 'Delete'}
                      </Button>
                    </div>
                  </td>
                </tr>
              )
            })}
          </AccountTable>
        </Box>
      ) : filtered ? (
        <Box className="p-4 text-sm">No backups match these filters.</Box>
      ) : (
        <Box className="p-4 text-sm">
          No backups yet. Turn on cloud backups on a linked backend under Settings, FrameOS Cloud, then use Back up now.
          Frames also back up on their own after every successful deploy.
        </Box>
      )}
    </div>
  )
}
