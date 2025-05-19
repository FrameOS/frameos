import { A } from 'kea-router'
import { AgentType } from '../../types'
import { H5 } from '../../components/H5'
import { Box } from '../../components/Box'
import { DropdownMenu } from '../../components/DropdownMenu'
import { TrashIcon } from '@heroicons/react/24/solid'
import { useActions } from 'kea'
import { agentsModel } from '../../models/agentsModel'

interface AgentProps {
  agent: AgentType
}

export function Agent({ agent }: AgentProps): JSX.Element {
  const { deleteAgent } = useActions(agentsModel)
  return (
    <Box id={`agent-${agent.id}`} className="relative">
      <div className="flex gap-2 absolute z-10 right-2 top-2">
        <DropdownMenu
          buttonColor="none"
          items={[
            {
              label: 'Delete',
              onClick: () => window.confirm(`Are you sure?`) && deleteAgent(agent.id),
              icon: <TrashIcon className="w-5 h-5" />,
            },
          ]}
        />
      </div>
      <div className="flex justify-between px-4 pt-2 mb-2">
        <H5 className="text-ellipsis overflow-hidden mr-2">{agent.device_id}</H5>
      </div>
      {agent.connected && (
        <div className="px-4 pb-2">
          <div className="flex sm:text-lg text-gray-400 items-center">🟢 Connected</div>
        </div>
      )}
    </Box>
  )
}
