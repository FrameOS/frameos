import { useActions, useValues } from 'kea'
import { router } from 'kea-router'
import { NewFrame } from './NewFrame'
import { Frame } from './Frame'
import { framesModel } from '../../models/framesModel'
import { Header } from '../../components/Header'
import versions from '../../../../versions.json'
import { Button } from '../../components/Button'
import { newFrameForm } from './newFrameForm'
import { Masonry } from '../../components/Masonry'
import { urls } from '../../urls'
import { useEffect } from 'react'
import { ArchiveBoxIcon, ChevronDownIcon, ChevronRightIcon } from '@heroicons/react/24/solid'

export function Frames() {
  const { activeFramesList, archivedFramesList, archivedFramesExpanded } = useValues(framesModel)
  const { formVisible } = useValues(newFrameForm)
  const { toggleArchivedFramesExpanded } = useActions(framesModel)
  const { showForm } = useActions(newFrameForm)

  useEffect(() => {
    async function runAsync() {
      await import('../frame/Frame')
    }
    window.setTimeout(runAsync, 1000)
  }, [])

  return (
    <div className="h-full w-full overflow-hidden max-w-screen max-h-screen left-0 top-0 absolute">
      <div className="flex flex-col h-full max-h-full">
        <div className="h-[60px]">
          <Header
            title="FrameOS"
            version={(versions.docker || 'dev').split('+')[0]}
            right={
              <Button color="secondary" onClick={() => router.actions.push(urls.settings())}>
                Settings
              </Button>
            }
          />
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-auto">
          <div className="flex-1">
            <Masonry id="frames" className="p-4">
              {activeFramesList.map((frame) => (
                <div key={`frame-${frame.id}`} className="mb-4">
                  <Frame frame={frame} />
                </div>
              ))}
            </Masonry>
            <div className="p-4">
              {formVisible ? (
                <NewFrame />
              ) : (
                <Button color="secondary" onClick={showForm}>
                  Add a smart frame
                </Button>
              )}
            </div>
          </div>
          {archivedFramesList.length > 0 ? (
            <section className="shrink-0 border-t border-gray-700 px-4 py-3">
              <button
                type="button"
                className="group flex w-full items-center justify-between gap-3 px-1 py-2 text-left transition focus:outline-none focus-visible:rounded-md focus-visible:ring-1 focus-visible:ring-gray-500"
                onClick={toggleArchivedFramesExpanded}
                aria-expanded={archivedFramesExpanded}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-gray-800 text-gray-300 transition group-hover:bg-gray-700 group-hover:text-white">
                    <ArchiveBoxIcon className="h-5 w-5" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold text-gray-100 group-hover:text-white">Archived</span>
                    <span className="block text-xs text-gray-400">
                      {archivedFramesList.length} frame{archivedFramesList.length === 1 ? '' : 's'}
                    </span>
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-2 text-sm text-gray-300">
                  {archivedFramesExpanded ? 'Hide' : 'Show'}
                  {archivedFramesExpanded ? (
                    <ChevronDownIcon className="h-5 w-5" />
                  ) : (
                    <ChevronRightIcon className="h-5 w-5" />
                  )}
                </span>
              </button>
              {archivedFramesExpanded ? (
                <Masonry id="archived-frames" className="pt-3">
                  {archivedFramesList.map((frame) => (
                    <div key={`archived-frame-${frame.id}`} className="mb-4 opacity-75 transition hover:opacity-100">
                      <Frame frame={frame} />
                    </div>
                  ))}
                </Masonry>
              ) : null}
            </section>
          ) : null}
        </div>
      </div>
    </div>
  )
}

export default Frames
