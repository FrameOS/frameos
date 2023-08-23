import { BindLogic, useActions, useValues } from 'kea'
import { H1 } from '../../components/H1'
import { frameLogic } from './frameLogic'
import { A } from 'kea-router'
import { Logs } from './Logs'
import { Image } from './Image'
import { Details } from './Details'
import { frameHost, frameUrl } from '../../decorators/frame'
import { Box } from '../../components/Box'
import { AddApps, Apps } from './Apps'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import Spinner from '../../components/Spinner'
import RenderLoop from './RenderLoop'
import { H6 } from '../../components/H6'
import { H5 } from '../../components/H5'
import { Button } from '../../components/Button'
import { framesModel } from '../../models/framesModel'

interface FrameSceneProps {
  id: string // from the URL
}

const defaultLayout = [33, 67]

export function Frame(props: FrameSceneProps) {
  const frameLogicProps = { id: parseInt(props.id) }
  const { frame } = useValues(frameLogic(frameLogicProps))
  const { redeployFrame, restartFrame, refreshFrame } = useActions(framesModel)

  const onLayout = (sizes: number[]) => {
    // document.cookie = `react-resizable-panels:layout=${JSON.stringify(sizes)}`;
    console.log(sizes)
  }

  return (
    <BindLogic logic={frameLogic} props={frameLogicProps}>
      {frame ? (
        <div className="h-full w-full max-w-screen max-h-screen left-0 top-0 absolute">
          <PanelGroup direction="vertical" units="pixels">
            <Panel minSize={60} maxSize={60}>
              <div className="bg-black text-white h-full w-full space-x-2 p-2 flex justify-between items-center">
                <H5>
                  <A href="/">FrameOS</A> <span className="text-gray-400">&raquo;</span>{' '}
                  {!frame ? `Loading frame ${props.id}...` : frameHost(frame)}
                </H5>
                <div className="flex space-x-2">
                  <Button type="button" onClick={() => refreshFrame(frame.id)}>
                    Refresh
                  </Button>
                  <Button type="button" onClick={() => restartFrame(frame.id)}>
                    Restart
                  </Button>
                  <Button type="button" onClick={() => redeployFrame(frame.id)}>
                    Redeploy
                  </Button>
                </div>
              </div>
            </Panel>
            <Panel>
              <PanelGroup direction="horizontal" onLayout={onLayout} units="percentages">
                <Panel defaultSize={33}>
                  <PanelGroup direction="vertical" onLayout={onLayout}>
                    <Panel defaultSize={40}>
                      <div className="overflow-auto w-full h-full max-w-full max-h-full p-2">
                        <a href={frameUrl(frame)}>
                          <Image id={frame.id} />
                        </a>
                      </div>
                    </Panel>
                    <PanelResizeHandle className="h-1 bg-gray-700 hover:bg-blue-600 active:bg-blue-800 transition duration-1000" />
                    <Panel defaultSize={60}>
                      <div className="overflow-auto w-full h-full max-w-full max-h-full p-2">
                        <Details id={frame.id} className="overflow-auto" />
                      </div>
                    </Panel>
                  </PanelGroup>
                </Panel>
                <PanelResizeHandle className="w-1 bg-gray-700 hover:bg-blue-600 active:bg-blue-800 transition duration-1000" />
                <Panel>
                  <div className="flex h-full max-h-full">
                    <div className="flex-1 w-full overflow-x-auto overflow-y-hidden max-h-full max-w-full">
                      <ul className="flex items-stretch flex-nowrap text-sm font-medium text-center text-gray-500 border-b border-gray-200 dark:border-gray-700 dark:text-gray-400">
                        <li className="mr-2">
                          <a
                            href="#"
                            aria-current="page"
                            className="h-full items-center inline-flex px-4 p-2 text-yellow-600 bg-gray-100 rounded-t-lg active dark:bg-gray-800 dark:text-yellow-500"
                          >
                            Render Queue
                          </a>
                        </li>
                        <li className="mr-2">
                          <a
                            href="#"
                            className="h-full items-center inline-flex px-4 p-2 rounded-t-lg hover:text-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800 dark:hover:text-gray-300"
                          >
                            Kiosk mode
                          </a>
                        </li>
                        <li className="mr-2">
                          <a
                            href="#"
                            className="h-full items-center inline-flex px-4 p-2 rounded-t-lg hover:text-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800 dark:hover:text-gray-300"
                          >
                            Edit app: Download URL
                          </a>
                        </li>
                        <li>
                          <a className="h-full items-center inline-flex px-4 p-2 text-gray-400 rounded-t-lg cursor-not-allowed dark:text-gray-500">
                            Frame Settings
                          </a>
                        </li>
                      </ul>
                    </div>
                    <PanelGroup direction="vertical">
                      <Panel defaultSize={60}>
                        <PanelGroup direction="horizontal" onLayout={onLayout}>
                          <Panel defaultSize={60}>
                            <div className="overflow-auto w-full h-full max-w-full max-h-full p-2">
                              <Apps id={frame.id} className="overflow-auto" />
                            </div>
                          </Panel>
                          <PanelResizeHandle className="w-1 bg-gray-700 hover:bg-blue-600 active:bg-blue-800 transition duration-1000" />
                          <Panel defaultSize={40}>
                            <div className="overflow-auto w-full h-full max-w-full max-h-full p-2">
                              <AddApps />
                            </div>
                          </Panel>
                        </PanelGroup>
                      </Panel>
                      <PanelResizeHandle className="h-1 bg-gray-700 hover:bg-blue-600 active:bg-blue-800 transition duration-1000" />
                      <Panel defaultSize={40}>
                        <Logs id={frame.id} />
                      </Panel>
                    </PanelGroup>
                  </div>
                </Panel>
              </PanelGroup>
            </Panel>
          </PanelGroup>
        </div>
      ) : (
        <div>
          Loading frame ${props.id} <Spinner />
        </div>
      )}
      {/* 
      <div className="space-y-4">
        <H1>
          <A href="/">FrameOS</A> <span className="text-gray-400">&raquo;</span>{' '}
          {!frame ? `Loading frame ${props.id}...` : frameHost(frame)}
        </H1>
        {frame ? (
          <>
            <Box className="m-auto max-w-max">
              <a href={frameUrl(frame)}>
                <Image id={frame.id} className="flex-1" />
              </a>
            </Box>
            <div className="flex space-x-4 items-start">
              <Details id={frame.id} className="flex-1" />
              <Apps id={frame.id} className="flex-1" />
            </div>
            <Logs id={frame.id} />
          </>
        ) : null}
      </div> */}
    </BindLogic>
  )
}

export default Frame
