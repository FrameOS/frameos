import { useActions } from 'kea'
import { Box } from '../../../../components/Box'
import { H6 } from '../../../../components/H6'
import { frameLogic } from '../../frameLogic'
import { Button } from '../../../../components/Button'
import templates from '../../../../templates.json'

export function Templates() {
  const { setFrameFormValues } = useActions(frameLogic)
  return (
    <>
      <div className="space-y-2 float-right">
        <Button size="small">Save as template</Button>
      </div>
      <div className="space-y-8">
        <div className="space-y-2">
          <H6>Local templates</H6>
          <div className="text-muted">You have no local templates.</div>
        </div>
        <div className="space-y-2">
          <H6>Official templates</H6>
          {templates.map((template) => (
            <Box className="bg-gray-900 px-3 py-2 dndnode space-y-2">
              <div className="flex items-center justify-between">
                <H6>{template.name}</H6>
                <Button
                  size="small"
                  color="light-gray"
                  onClick={() => {
                    if (confirm(`Are you sure you want to replace the scene with the "${template.name}" template?`)) {
                      setFrameFormValues({
                        ...('scenes' in template ? { scenes: template.scenes } : {}),
                        ...('interval' in template ? { interval: template.interval } : {}),
                        ...('background_color' in template ? { background_color: template.background_color } : {}),
                      })
                    }
                  }}
                >
                  Replace
                </Button>
              </div>
              <div className="text-gray-400 text-sm">{template.description}</div>
            </Box>
          ))}
        </div>
      </div>
    </>
  )
}
