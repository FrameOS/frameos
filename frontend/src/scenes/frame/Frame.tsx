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
import clsx from 'clsx'

interface FrameSceneProps {
  id: string // from the URL
}

const defaultLayout = [33, 67]

const Handle = ({ className }: { className: string }): JSX.Element => (
  <PanelResizeHandle
    className={clsx('bg-gray-900 hover:bg-blue-600 active:bg-blue-800 transition duration-1000', className)}
  />
)
const Container = ({ header, children }: { header?: React.ReactNode; children: React.ReactNode }): JSX.Element => {
  return (
    <div className="flex flex-col w-full h-full max-w-full max-h-full">
      {header ? <div>{header}</div> : null}
      <Box className="overflow-auto w-full h-full max-w-full max-h-full p-4 m-2 rounded-lg">
        <div className="overflow-auto w-full h-full max-w-full max-h-full rounded-lg">{children}</div>
      </Box>
    </div>
  )
}
const Tabs = ({ children, className }: { children: React.ReactNode; className?: string }): JSX.Element => {
  return (
    <div
      className={clsx(
        'flex items-start flex-nowrap text-sm font-medium text-center text-gray-500 dark:border-gray-700 dark:text-gray-400 px-2',
        className
      )}
    >
      {children}
    </div>
  )
}

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
              <div className="bg-gray-800 text-white h-full w-full space-x-2 p-2 flex justify-between items-center">
                <H5>
                  <A href="/">FrameOS</A> <span className="text-gray-400">&raquo;</span>{' '}
                  {!frame ? `Loading frame ${props.id}...` : frameHost(frame)}
                </H5>
                <div className="flex space-x-2">
                  <Button color="light-gray" type="button" onClick={() => refreshFrame(frame.id)}>
                    Refresh
                  </Button>
                  <Button color="light-gray" type="button" onClick={() => restartFrame(frame.id)}>
                    Restart
                  </Button>
                  <Button color="light-gray" type="button" onClick={() => redeployFrame(frame.id)}>
                    Redeploy
                  </Button>
                </div>
              </div>
            </Panel>
            <Panel className="p-2 pb-4 pr-4">
              <PanelGroup direction="horizontal" onLayout={onLayout} units="percentages">
                <Panel defaultSize={33}>
                  <PanelGroup direction="vertical" onLayout={onLayout}>
                    <Panel defaultSize={40}>
                      <Container
                        header={
                          <Tabs className="w-auto mt-2">
                            <Button color="light-gray" className="w-auto">
                              Preview
                            </Button>
                          </Tabs>
                        }
                      >
                        <a href={frameUrl(frame)}>
                          <Image id={frame.id} />
                        </a>
                      </Container>
                    </Panel>
                    <Handle className="h-1" />
                    <Panel defaultSize={60}>
                      <Container
                        header={
                          <Tabs className="w-auto mt-2">
                            <Button color="light-gray" className="w-auto">
                              Details
                            </Button>
                          </Tabs>
                        }
                      >
                        <Details id={frame.id} className="overflow-auto" />
                      </Container>
                    </Panel>
                  </PanelGroup>
                </Panel>
                <Handle className="w-1" />
                <Panel>
                  <PanelGroup direction="vertical">
                    <Panel defaultSize={60}>
                      <PanelGroup direction="horizontal" onLayout={onLayout}>
                        <Panel defaultSize={60}>
                          <Container
                            header={
                              <Tabs className="w-auto mt-2">
                                <Button color="light-gray" className="w-auto">
                                  Render queue
                                </Button>
                                <Button color="gray" className="w-auto">
                                  Tab2
                                </Button>
                                <Button color="gray" className="w-auto">
                                  Tab3
                                </Button>
                              </Tabs>
                            }
                          >
                            <Apps id={frame.id} className="overflow-auto" />
                          </Container>
                        </Panel>
                        <Handle className="2-1" />
                        <Panel defaultSize={40}>
                          <Container
                            header={
                              <Tabs className="w-auto mt-2">
                                <Button color="light-gray" className="w-auto">
                                  Add apps
                                </Button>
                              </Tabs>
                            }
                          >
                            <AddApps />
                          </Container>
                        </Panel>
                      </PanelGroup>
                    </Panel>
                    <Handle className="h-1" />
                    <Panel defaultSize={40}>
                      <Container>
                        <Logs id={frame.id} />
                      </Container>
                    </Panel>
                  </PanelGroup>
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
