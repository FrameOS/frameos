import { useActions, useValues } from 'kea'
import { frameLogic } from '../../frameLogic'
import { templatesLogic } from './templatesLogic'
import { Button } from '../../../../components/Button'
import { Form } from 'kea-forms'
import { Modal } from '../../../../components/Modal'
import { Field } from '../../../../components/Field'
import { TextInput } from '../../../../components/TextInput'
import { TextArea } from '../../../../components/TextArea'
import { Image } from '../Image/Image'
import { Box } from '../../../../components/Box'
import { H6 } from '../../../../components/H6'
import { Tag } from '../../../../components/Tag'
import { CheckIcon } from '@heroicons/react/24/solid'
import clsx from 'clsx'
import { Spinner } from '../../../../components/Spinner'
import React, { useEffect, useMemo, useState } from 'react'
import { Label } from '../../../../components/Label'
import { FrameImage } from '../../../../components/FrameImage'

const MODAL_TITLES: Record<string, string> = {
  localTemplate: 'Save to "My scenes"',
  zip: 'Download as .zip',
  cloud: 'Save to cloud drive',
}

const SUBMIT_LABELS: Record<string, string> = {
  localTemplate: 'Save to "My scenes"',
  zip: 'Download .zip',
  cloud: 'Save to cloud drive',
}

export function EditTemplateModal() {
  const { frameId, frame, sortedScenes } = useValues(frameLogic)
  const { isTemplateFormSubmitting, showingModal, modalTarget, templateForm } = useValues(templatesLogic({ frameId }))
  const { hideModal, submitTemplateForm } = useActions(templatesLogic({ frameId }))
  const newTemplate = !templateForm.id

  // Scenes selected when the modal opened float to the top (they are what
  // you came here to save); toggling later does not reshuffle the list.
  const [initialSelection, setInitialSelection] = useState<string[]>([])
  useEffect(() => {
    if (showingModal) {
      setInitialSelection(templateForm.exportScenes ?? [])
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showingModal])
  const orderedScenes = useMemo(() => {
    const selected = new Set(initialSelection)
    return [...sortedScenes].sort((a, b) => Number(selected.has(b.id)) - Number(selected.has(a.id)))
  }, [initialSelection, sortedScenes])

  // The preview image is what gets saved with the template: the frame's
  // current snapshot when the active scene is included in the export,
  // otherwise the first selected scene's cached snapshot.
  const exportScenes = templateForm.exportScenes ?? []
  const activeSceneId = frame?.active_scene_id
  const imageSceneId = activeSceneId && exportScenes.includes(activeSceneId) ? undefined : exportScenes[0]

  return (
    <>
      {showingModal ? (
        <Form logic={templatesLogic} props={{ frameId }} formKey="templateForm">
          <Modal
            title={newTemplate ? (MODAL_TITLES[modalTarget] ?? MODAL_TITLES.localTemplate) : 'Edit template'}
            onClose={hideModal}
            open={showingModal}
            footer={
              <div className="flex items-top justify-end gap-2 rounded-b border-t border-solid border-slate-500/20 p-6">
                <Button color="none" onClick={hideModal}>
                  Close
                </Button>
                <Button color="primary" onClick={submitTemplateForm} className="flex gap-2 items-center">
                  {isTemplateFormSubmitting ? <Spinner color="white" /> : null}
                  <div>{newTemplate ? (SUBMIT_LABELS[modalTarget] ?? SUBMIT_LABELS.localTemplate) : 'Save changes'}</div>
                </Button>
              </div>
            }
          >
            <div className="frame-tool-panel relative flex-auto space-y-4 p-6">
              <Field name="name" label="Template name">
                <TextInput placeholder="Template name" required />
              </Field>
              <Field name="description" label="Description">
                <TextArea placeholder="Pretty pictures..." rows={4} required />
              </Field>
              {newTemplate ? (
                <>
                  <Field name="exportScenes">
                    {({ value, onChange }) => (
                      <>
                        <div className="flex gap-2">
                          <Label>
                            {`Scenes included in template (${templateForm.exportScenes?.length ?? 0} selected)`}
                          </Label>
                          {(templateForm.exportScenes?.length ?? 0) > 0 ? (
                            <Button size="tiny" color="secondary" onClick={() => onChange([])}>
                              clear
                            </Button>
                          ) : null}
                          {(templateForm.exportScenes?.length ?? 0) < sortedScenes.length ? (
                            <Button
                              size="tiny"
                              color="secondary"
                              onClick={() => onChange(sortedScenes.map((s) => s.id))}
                            >
                              select all
                            </Button>
                          ) : null}
                        </div>
                        {orderedScenes.map((scene) => {
                          const included = (value || []).includes(scene.id)
                          return (
                            <Box
                              key={scene.id}
                              className={clsx(
                                'frame-tool-card flex cursor-pointer flex-row items-center gap-3 rounded-[18px] p-2 transition',
                                included
                                  ? 'frameos-primary-active text-white ring-2 ring-blue-400/70 shadow-md'
                                  : 'opacity-75 hover:opacity-100 hover:bg-slate-500/10'
                              )}
                              onClick={(e) => {
                                e.preventDefault()
                                onChange(
                                  included
                                    ? (value || []).filter((v: string) => v !== scene.id)
                                    : [...(value || []), scene.id]
                                )
                              }}
                            >
                              <FrameImage
                                frameId={frameId}
                                sceneId={scene.id}
                                className="max-h-[120px] max-w-[120px] cursor-pointer rounded-xl"
                                refreshable={false}
                                thumb
                              />
                              <div className="flex flex-1 items-start justify-between gap-1">
                                <div>
                                  <H6>
                                    {scene.name || scene.id}
                                    {scene.default ? (
                                      <Tag className="ml-2" color="gray">
                                        default
                                      </Tag>
                                    ) : null}
                                  </H6>
                                  <div className={clsx('text-xs', included ? 'text-white/70' : 'frame-tool-muted')}>
                                    id: {scene.id}
                                  </div>
                                </div>
                              </div>
                              {included ? <CheckIcon className="w-5 h-5" /> : null}
                            </Box>
                          )
                        })}
                      </>
                    )}
                  </Field>
                  <Field name="image" label="Preview image (saved with the template)">
                    {imageSceneId ? (
                      <div className="space-y-1">
                        <FrameImage frameId={frameId} sceneId={imageSceneId} refreshable={false} />
                        <div className="frame-tool-muted text-xs">
                          The cached snapshot of the first selected scene — the frame currently shows a scene that is
                          not part of this template.
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-1">
                        <Image />
                        <div className="frame-tool-muted text-xs">
                          The frame&apos;s current snapshot. This image is shown wherever the template is listed.
                        </div>
                      </div>
                    )}
                  </Field>
                </>
              ) : null}
            </div>
          </Modal>
        </Form>
      ) : null}
    </>
  )
}
