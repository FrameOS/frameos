import { BindLogic, useValues } from 'kea'
import { frameLogic } from '../frameLogic'
import { Panel, PanelGroup } from 'react-resizable-panels'
import { Handle } from '../../../components/panels/Handle'
import { Area } from '../../../types'
import { PanelArea } from './PanelArea'
import { panelsLogic } from './panelsLogic'
import { EditTemplateModal } from './Templates/EditTemplateModal'

export function Panels() {
  const { frameId, frame } = useValues(frameLogic)
  const { panelsWithConditions: panels } = useValues(panelsLogic({ frameId }))

  return frame ? (
    <BindLogic logic={panelsLogic} props={{ frameId }}>
      <PanelGroup direction="horizontal" className="flex-1 p-4">
        {panels.TopLeft.length > 0 || panels.BottomLeft.length > 0 ? (
          <Panel>
            <PanelGroup direction="vertical">
              {panels.TopLeft.length > 0 ? (
                <Panel defaultSize={60}>
                  <PanelArea area={Area.TopLeft} areaPanels={panels.TopLeft} />
                </Panel>
              ) : null}
              {panels.TopLeft.length > 0 && panels.BottomLeft.length > 0 ? <Handle direction="vertical" /> : null}
              {panels.BottomLeft.length > 0 ? (
                <Panel defaultSize={40}>
                  <PanelArea area={Area.BottomLeft} areaPanels={panels.BottomLeft} />
                </Panel>
              ) : null}
            </PanelGroup>
          </Panel>
        ) : null}
        {(panels.TopLeft.length > 0 || panels.BottomLeft.length > 0) &&
        (panels.TopRight.length > 0 || panels.BottomRight.length > 0) ? (
          <Handle direction="horizontal" />
        ) : null}
        {panels.TopRight.length > 0 || panels.BottomRight.length > 0 ? (
          <Panel defaultSize={33}>
            <PanelGroup direction="vertical">
              {panels.TopRight.length > 0 ? (
                <Panel defaultSize={60}>
                  <PanelArea area={Area.TopRight} areaPanels={panels.TopRight} />
                </Panel>
              ) : null}
              {panels.TopRight.length > 0 && panels.BottomRight.length > 0 ? <Handle direction="vertical" /> : null}
              {panels.BottomRight.length > 0 ? (
                <Panel defaultSize={40}>
                  <PanelArea area={Area.BottomRight} areaPanels={panels.BottomRight} />
                </Panel>
              ) : null}
            </PanelGroup>
          </Panel>
        ) : null}
      </PanelGroup>
      <EditTemplateModal />
    </BindLogic>
  ) : null
}
