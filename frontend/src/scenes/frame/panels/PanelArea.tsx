import { allPanels } from './allPanels'
import { Container } from '../../../components/panels/Container'
import { Tabs } from '../../../components/panels/Tabs'
import { Tab } from '../../../components/panels/Tab'
import { Area, PanelWithMetadata } from '../../../types'
import { useActions, useValues } from 'kea'
import { panelsLogic } from './panelsLogic'
import { frameLogic } from '../frameLogic'

export interface PanelAreaProps {
  area: Area
  areaPanels: PanelWithMetadata[]
}

function pascalCaseToTitleCase(pascalCase: string): string {
  const words = pascalCase.replace(/([a-z])([A-Z])/g, '$1 $2').split(' ')
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(' ')
}

export function PanelArea({ area, areaPanels }: PanelAreaProps): JSX.Element {
  const { frameId } = useValues(frameLogic)
  const { setPanel, closePanel, toggleFullScreenPanel } = useActions(panelsLogic({ frameId }))

  // Don't look at panel.active directly, as many might have it set
  const activePanel = areaPanels.find((panel) => panel.active) ?? areaPanels.find((panel) => !panel.hidden)
  const Component = activePanel ? allPanels[activePanel.panel] : null

  return (
    <Container
      header={
        <Tabs>
          {areaPanels
            .filter((panel) => !panel.hidden || panel.active)
            .map((panel) => {
              const Comp = allPanels[panel.panel]
              const PanelTitle: ((props: Record<string, any>) => JSX.Element) | null =
                Comp && 'PanelTitle' in Comp ? (Comp.PanelTitle as any) : null

              return (
                <Tab
                  key={panel.key}
                  active={activePanel === panel}
                  onClick={() => setPanel(area, panel)}
                  onDoubleClick={() => toggleFullScreenPanel(panel)}
                  className="select-none"
                  closable={panel.closable}
                  onClose={() => closePanel(panel)}
                >
                  {PanelTitle ? (
                    <PanelTitle panel={panel} {...(panel?.metadata ?? {})} />
                  ) : (
                    <>{panel.title ?? pascalCaseToTitleCase(panel.panel)}</>
                  )}
                </Tab>
              )
            })}
        </Tabs>
      }
    >
      {Component ? <Component panel={activePanel} {...(activePanel?.metadata ?? {})} /> : <>Nothing to see here...</>}
    </Container>
  )
}
