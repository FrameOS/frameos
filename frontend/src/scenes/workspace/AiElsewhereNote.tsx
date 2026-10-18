/**
 * Where AI scene generation lives, said from the on-device panel. The frame
 * has no AI to ask and no account to bill one to, so every AI entry there
 * (Generate scene, the AI chat buttons) gives this answer instead of a dead
 * end: where the generator is, and how a scene made there gets back here.
 */
export function AiElsewhereNote(): JSX.Element {
  return (
    <>
      <div className="frameos-muted">Not from here. This panel is the frame itself, and the frame has no AI to ask.</div>
      <div className="frameos-muted">
        Generate a scene at{' '}
        <a
          href="https://scenes.frameos.net"
          target="_blank"
          rel="noreferrer"
          className="frameos-link font-medium hover:underline"
        >
          scenes.frameos.net
        </a>
        , download it, and bring it back with <span className="frameos-strong font-semibold">Upload scene</span>.
      </div>
      <div className="frameos-muted">
        Or connect this frame to FrameOS Cloud and scenes move both ways without the download.
      </div>
    </>
  )
}
