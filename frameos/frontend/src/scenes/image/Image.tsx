import { useActions, useValues } from 'kea'

import { imageLogic } from './imageLogic'

export default function Image() {
  const { imageSlots, activeIndex, scalingMode } = useValues(imageLogic)
  const { toggleScalingMode } = useActions(imageLogic)

  const primaryStyle = {
    backgroundImage: imageSlots[0] ? `url(${imageSlots[0]})` : undefined,
    backgroundSize: scalingMode,
    opacity: activeIndex === 0 ? 1 : 0,
  }
  const secondaryStyle = {
    backgroundImage: imageSlots[1] ? `url(${imageSlots[1]})` : undefined,
    backgroundSize: scalingMode,
    opacity: activeIndex === 1 ? 1 : 0,
  }

  return (
    <div className="relative min-h-screen bg-black" onClick={toggleScalingMode}>
      <div className="absolute inset-0 bg-center bg-no-repeat transition-opacity duration-1000" style={primaryStyle} />
      <div className="absolute inset-0 bg-center bg-no-repeat transition-opacity duration-1000" style={secondaryStyle} />
    </div>
  )
}
