import clsx from 'clsx'

interface SceneDependencyConnectorProps {
  compact?: boolean
}

export function SceneDependencyConnector({ compact }: SceneDependencyConnectorProps): JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={clsx('frameos-scene-dependency-connector', compact && 'frameos-scene-dependency-connector--compact')}
    >
      <span className="frameos-scene-dependency-dot-grid">
        {Array.from({ length: 16 }).map((_, index) => (
          <span key={index} className="frameos-scene-dependency-dot" />
        ))}
      </span>
    </span>
  )
}
