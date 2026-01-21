import { allPanels } from './allPanels'
import { Container } from '../../../components/panels/Container'
import { Tabs } from '../../../components/panels/Tabs'
import { Tab } from '../../../components/panels/Tab'
import { Area, PanelWithMetadata } from '../../../types'
import { useActions, useValues } from 'kea'
import { panelScrollKey, panelsLogic } from './panelsLogic'
import { frameLogic } from '../frameLogic'
import { ArrowLeftIcon } from '@heroicons/react/24/outline'
import { useCallback, useEffect, useRef, type UIEvent } from 'react'

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
  const { setPanel, closePanel, toggleFullScreenPanel, disableFullscreenPanel, rememberPanelScroll } = useActions(
    panelsLogic({ frameId })
  )
  const { panelScrollPositions } = useValues(panelsLogic({ frameId }))
  const scrollContainerRef = useRef<HTMLDivElement | null>(null)
  const lastPanelKeyRef = useRef<string | null>(null)

  // Don't look at panel.active directly, as many might have it set
  const activePanel = areaPanels.find((panel) => panel.active) ?? areaPanels.find((panel) => !panel.hidden)
  const Component = activePanel ? allPanels[activePanel.panel] : null
  const activePanelKey = activePanel ? panelScrollKey(activePanel) : null
  const savedScrollTop = activePanelKey ? panelScrollPositions[activePanelKey] ?? 0 : 0

  useEffect(() => {
    if (!activePanelKey) {
      lastPanelKeyRef.current = null
      return
    }

    if (lastPanelKeyRef.current === activePanelKey) {
      return
    }

    lastPanelKeyRef.current = activePanelKey

    const container = scrollContainerRef.current
    if (!container) {
      return
    }

    container.scrollTop = savedScrollTop
    const timeoutId = window.setTimeout(() => {
      if (scrollContainerRef.current) {
        scrollContainerRef.current.scrollTop = savedScrollTop
      }
    }, 10)

    return () => window.clearTimeout(timeoutId)
  }, [activePanelKey, savedScrollTop])

  const handleScroll = useCallback(
    (event: UIEvent<HTMLDivElement>) => {
      if (!activePanel) {
        return
      }
      rememberPanelScroll(activePanel, event.currentTarget.scrollTop)
    },
    [activePanel, rememberPanelScroll]
  )

  return (
    <Container
      scrollRef={scrollContainerRef}
      onScroll={handleScroll}
      header={
        <Tabs>
          {areaPanels
            .filter((panel) => !panel.hidden || panel.active)
            .map((panel, index) => {
              const Comp = allPanels[panel.panel]
              const PanelTitle: ((props: Record<string, any>) => JSX.Element) | null =
                Comp && 'PanelTitle' in Comp ? (Comp.PanelTitle as any) : null

              return (
                <Tab
                  key={index}
                  active={activePanel === panel}
                  onClick={() =>
                    panel.key === 'action:disableFullscreenPanel' ? disableFullscreenPanel() : setPanel(area, panel)
                  }
                  onDoubleClick={() => toggleFullScreenPanel(panel)}
                  className="select-none"
                  closable={panel.closable}
                  onClose={() => closePanel(panel)}
                >
                  {panel.key === 'action:disableFullscreenPanel' ? (
                    <ArrowLeftIcon className="w-5 h-5" />
                  ) : PanelTitle ? (
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
