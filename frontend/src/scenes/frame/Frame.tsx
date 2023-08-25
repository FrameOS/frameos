import { BindLogic, useActions, useValues } from 'kea'
import { frameLogic } from './frameLogic'
import { Logs } from './Logs'
import { Image } from './Image'
import { Details } from './Details'
import { frameHost, frameUrl } from '../../decorators/frame'
import { AddApps, Apps } from './Apps'
import { Panel, PanelGroup } from 'react-resizable-panels'
import { Spinner } from '../../components/Spinner'
import { Diagram } from './Diagram/Diagram'
import { Button } from '../../components/Button'
import { framesModel } from '../../models/framesModel'
import { detailsLogic } from './detailsLogic'
import { Header } from '../../components/Header'
import { Container } from '../../components/panels/Container'
import { Tab } from '../../components/panels/Tab'
import { Tabs } from '../../components/panels/Tabs'
import { Handle } from '../../components/panels/Handle'

interface FrameSceneProps {
  id: string // taken straight from the URL, thus a string
}

export function Frame(props: FrameSceneProps) {
  const id = parseInt(props.id)
  const frameLogicProps = { id }
  const { frame, tab, selectedNodeId } = useValues(frameLogic(frameLogicProps))
  const { setTab, deselectNode } = useActions(frameLogic(frameLogicProps))
  const { redeployFrame, restartFrame, refreshFrame } = useActions(framesModel)

  const { editFrame, closeEdit } = useActions(detailsLogic({ id }))
  const { editing } = useValues(detailsLogic({ id }))

  const onLayout = (sizes: number[]) => {
    // document.cookie = `react-resizable-panels:layout=${JSON.stringify(sizes)}`;
    console.log(sizes)
  }

  return (
    <BindLogic logic={frameLogic} props={frameLogicProps}>
      {frame ? (
        <div className="h-full w-full max-w-screen max-h-screen left-0 top-0 absolute flex flex-col">
          <Header
            title="FrameOS"
            subtitle={!frame ? `Loading frame ${props.id}...` : frameHost(frame)}
            buttons={[
              <Button color="light-gray" type="button" onClick={() => refreshFrame(frame.id)}>
                Refresh
              </Button>,
              <Button color="light-gray" type="button" onClick={() => restartFrame(frame.id)}>
                Restart
              </Button>,
              <Button color="light-gray" type="button" onClick={() => redeployFrame(frame.id)}>
                Redeploy
              </Button>,
            ]}
          />
          <PanelGroup direction="horizontal" onLayout={onLayout} units="percentages" className="flex-1 p-4">
            <Panel defaultSize={33}>
              <PanelGroup direction="vertical" onLayout={onLayout}>
                <Panel defaultSize={40}>
                  <Container
                    header={
                      <Tabs>
                        <Tab active>Preview</Tab>
                      </Tabs>
                    }
                  >
                    <a href={frameUrl(frame)}>
                      <Image id={frame.id} />
                    </a>
                  </Container>
                </Panel>
                <Handle direction="vertical" />
                <Panel defaultSize={60}>
                  <Container
                    header={
                      <Tabs>
                        <Tab active={!editing} onClick={() => closeEdit()}>
                          Details
                        </Tab>
                        <Tab active={editing} onClick={() => editFrame(frame)}>
                          Edit
                        </Tab>
                      </Tabs>
                    }
                  >
                    <Details id={frame.id} className="overflow-auto" />
                  </Container>
                </Panel>
              </PanelGroup>
            </Panel>
            <Handle direction="horizontal" />
            <Panel>
              <PanelGroup direction="vertical">
                <Panel defaultSize={60}>
                  <PanelGroup direction="horizontal" onLayout={onLayout}>
                    <Panel defaultSize={60}>
                      <Container
                        header={
                          <Tabs>
                            <Tab active={tab === 'diagram'} onClick={() => setTab('diagram')}>
                              Default Scene
                            </Tab>
                            <Tab active={tab === 'list'} onClick={() => setTab('list')}>
                              Render queue
                            </Tab>
                            <Tab active={tab === 'scene'} onClick={() => setTab('scene')}>
                              + Add Scene
                            </Tab>
                          </Tabs>
                        }
                      >
                        {tab === 'list' ? (
                          <Apps id={frame.id} className="overflow-auto" />
                        ) : tab === 'diagram' ? (
                          <Diagram />
                        ) : (
                          <>Nothing to see here...</>
                        )}
                      </Container>
                    </Panel>
                    <Handle direction="horizontal" />
                    <Panel defaultSize={40}>
                      <Container
                        header={
                          <Tabs>
                            {selectedNodeId ? <Tab active>Node</Tab> : null}
                            <Tab active={!selectedNodeId} onClick={deselectNode}>
                              Add apps
                            </Tab>
                          </Tabs>
                        }
                      >
                        {selectedNodeId ? null : <AddApps />}
                      </Container>
                    </Panel>
                  </PanelGroup>
                </Panel>
                <Handle direction="vertical" />
                <Panel defaultSize={40}>
                  <Container
                    header={
                      <Tabs>
                        <Tab active>Frame Logs</Tab>
                      </Tabs>
                    }
                  >
                    <Logs id={frame.id} />
                  </Container>
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
    </BindLogic>
  )
}

export default Frame
