import { Box } from '../../components/Box'

interface ContainerProps {
  header?: React.ReactNode
  children: React.ReactNode
}

export function Container({ header, children }: ContainerProps): JSX.Element {
  return (
    <div className="flex flex-col w-full h-full max-w-full max-h-full">
      {header ? (
        <div style={{ marginBottom: -1 }} className="z-10">
          {header}
        </div>
      ) : null}
      <Box className="overflow-auto w-full h-full max-w-full max-h-full rounded-lg rounded-tl-none p-2 z-0">
        <div className="overflow-auto w-full h-full max-w-full max-h-full rounded-lg rounded-tl-none">{children}</div>
      </Box>
    </div>
  )
}
