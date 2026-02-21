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

export function Frames() {
  const { framesList } = useValues(framesModel)
  const { formVisible } = useValues(newFrameForm)
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
            version={(versions.backend || 'dev').split('+')[0]}
            right={
              <Button color="secondary" onClick={() => router.actions.push(urls.settings())}>
                Settings
              </Button>
            }
          />
        </div>
        <div className="overflow-auto h-full">
          <Masonry id="frames" className="p-4">
            {framesList.map((frame) => (
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
      </div>
    </div>
  )
}

export default Frames
