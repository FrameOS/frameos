import { Box } from '../../../components/Box'
import { SshKeysSection } from '../../../components/sshKeys/SshKeysSection'
import { AccountPageHeader } from './AccountPageHeader'

// The account's SSH public keys: the one SSH key list (sshKeysLogic), which
// the SD card builders and the frame settings panel also draw, so a key
// added here is offered there at once.
export function SshKeysPage(): JSX.Element {
  return (
    <div>
      <AccountPageHeader page="ssh" />
      <Box className="p-4">
        <SshKeysSection />
      </Box>
    </div>
  )
}
