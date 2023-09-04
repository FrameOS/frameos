import { allPanels } from './allPanels'
import { Container } from '../../../components/panels/Container'
import { Tabs } from '../../../components/panels/Tabs'
import { Tab } from '../../../components/panels/Tab'
import { Area, Panel as PanelType, PanelWithMetadata } from '../../../types'

export interface PanelAreaProps {
  area: Area
  areaPanels: PanelWithMetadata[]
  setPanel: (area: Area, panel: PanelType) => void
  toggleFullScreenPanel: (panel: PanelType) => void
}

function pascalCaseToTitleCase(pascalCase: string): string {
  const words = pascalCase.replace(/([a-z])([A-Z])/g, '$1 $2').split(' ')
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(' ')
}

export function PanelArea({ area, areaPanels, setPanel, toggleFullScreenPanel }: PanelAreaProps): JSX.Element {
  // Don't look at panel.active directly, as many might have it set
  const activePanel = areaPanels.find((panel) => panel.active) ?? areaPanels.find((panel) => !panel.hidden)
  const Component = activePanel ? allPanels[activePanel.panel] : null

  return (
    <Container
      header={
        <Tabs>
          {areaPanels
            .filter((panel) => !panel.hidden || panel.active)
            .map((panel) => (
              <Tab
                key={panel.panel}
                active={activePanel === panel}
                onClick={() => setPanel(area, panel.panel)}
                onDoubleClick={() => toggleFullScreenPanel(panel.panel)}
                className="select-none"
              >
                {panel.label ??
                  (panel?.metadata?.sceneId ? `Scene: ${panel.metadata.sceneId}` : pascalCaseToTitleCase(panel.panel))}
              </Tab>
            ))}
        </Tabs>
      }
    >
      {Component ? <Component {...(activePanel?.metadata ?? {})} /> : <>Nothing to see here...</>}
    </Container>
  )
}
