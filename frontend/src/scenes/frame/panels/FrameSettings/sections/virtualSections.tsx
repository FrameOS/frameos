import { useActions, useValues } from 'kea'
import { Button } from '../../../../../components/Button'
import { Field } from '../../../../../components/Field'
import { Spinner } from '../../../../../components/Spinner'
import { TextInput } from '../../../../../components/TextInput'
import { frameLogic } from '../../../frameLogic'
import { cloudVirtualFrameLogic, virtualIntervalLabel } from '../cloudVirtualFrameLogic'
import { VirtualFrameUrlRow } from '../frameSettingsHelpers'
import { SectionBody, SectionHeading } from './FrameSettingsSection'

/**
 * A cloud virtual frame's own settings: where it is shown, how big it is and
 * what its last render came to. It sits in the frame form for its place in
 * the panel but binds no field: size and link apply at once, through their
 * own route (cloudVirtualFrameLogic).
 */
export function CloudVirtualFrameSection(): JSX.Element {
  const { frameId } = useValues(frameLogic)
  const logic = cloudVirtualFrameLogic({ frameId })
  const { virtual, loading, error, width, height, canSaveSize, request } = useValues(logic)
  const { setWidth, setHeight, saveSize, resetLink } = useActions(logic)

  return (
    // A fragment like every section: the panel's CSS styles `form > h6 + div`.
    <>
      <SectionHeading id="frame-settings-virtual">Virtual frame</SectionHeading>
      <SectionBody>
        <p className="frameos-muted text-sm">
          This frame has no hardware. FrameOS Cloud draws its scenes and shows the picture at the link below: open it in
          a browser on the screen that should show it. Its scenes run on FrameOS Cloud, so a scene that needs one of
          your service keys uses it there, and scenes cannot reach your home network.
        </p>
        {loading && !virtual ? (
          <Spinner />
        ) : virtual ? (
          <>
            <VirtualFrameUrlRow label="Link to show the frame" url={virtual.view_url} />
            <VirtualFrameUrlRow label="The picture alone (PNG)" url={virtual.image_url} />
            <Field name="_noop" label="Link">
              <div className="w-full space-y-1">
                <Button
                  type="button"
                  size="small"
                  color="secondary"
                  className="inline-flex items-center gap-1.5"
                  disabled={request !== 'idle'}
                  onClick={resetLink}
                >
                  {request === 'resettingLink' ? <Spinner /> : null}
                  Replace the link
                </Button>
                <p className="frameos-muted text-xs">
                  Anyone with the link can see this frame&apos;s picture, and nothing else of your account. Replacing it
                  ends every copy of the old one.
                </p>
              </div>
            </Field>
            <Field name="_noop" label="Size in pixels">
              <div className="w-full space-y-1">
                <div className="flex items-center gap-2">
                  <TextInput
                    aria-label="Width"
                    className="!w-24"
                    inputMode="numeric"
                    value={width}
                    onChange={setWidth}
                  />
                  <span className="frameos-muted text-sm">×</span>
                  <TextInput
                    aria-label="Height"
                    className="!w-24"
                    inputMode="numeric"
                    value={height}
                    onChange={setHeight}
                  />
                  <Button
                    type="button"
                    size="small"
                    color="secondary"
                    className="inline-flex items-center gap-1.5"
                    disabled={!canSaveSize}
                    onClick={saveSize}
                  >
                    {request === 'savingSize' ? <Spinner /> : null}
                    Change size
                  </Button>
                </div>
                <p className="frameos-muted text-xs">Applies at once: the frame is drawn again at the new size.</p>
              </div>
            </Field>
            <Field name="_noop" label="Drawing">
              <div className="w-full space-y-1 text-sm">
                <p>
                  While someone is looking, {virtualIntervalLabel(virtual.interval_seconds)}
                  {virtual.interval_seconds <= virtual.min_interval_seconds
                    ? ' (the most often a frame the cloud draws can refresh)'
                    : ''}
                  . A picture nobody looks at is not drawn again.
                </p>
                <p className="frameos-muted text-xs">
                  {virtual.rendered_at
                    ? `Last drawn ${new Date(virtual.rendered_at).toLocaleString()}${
                        virtual.render_ms !== null ? ` in ${(virtual.render_ms / 1000).toFixed(1)} s` : ''
                      }.`
                    : 'Not drawn yet. Give it a scene, or open its link.'}
                </p>
                {virtual.render_error ? (
                  <p className="text-xs font-semibold text-amber-600" role="alert">
                    The last attempt failed: {virtual.render_error}. The picture before it is still showing.
                  </p>
                ) : null}
              </div>
            </Field>
          </>
        ) : null}
        {error ? (
          <p className="text-sm font-semibold text-amber-600" role="alert">
            {error}
          </p>
        ) : null}
      </SectionBody>
    </>
  )
}
