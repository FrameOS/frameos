import { Modal } from '../../../../components/Modal'
import type { FrameEditor } from '../../frameEditorsLogic'
import { EditApp } from './EditApp'

/**
 * An app's source over the scene it belongs to: the store's embedded editor
 * and the frames workspace both edit apps this way, so the diagram stays
 * where it was when the modal closes.
 */
export function EditAppModal({ editor, onClose }: { editor: FrameEditor; onClose: () => void }): JSX.Element {
  return (
    <Modal
      open
      onClose={onClose}
      title={editor.title || 'Edit app source'}
      panelClassName="max-w-[min(1200px,calc(100vw-2rem))]"
      bodyClassName="h-[calc(100dvh-11rem)]"
    >
      <div className="h-full min-h-0 overflow-hidden">
        <EditApp editorKey={editor.key} sceneId={editor.sceneId} nodeId={editor.nodeId ?? ''} showToolbar />
      </div>
    </Modal>
  )
}
