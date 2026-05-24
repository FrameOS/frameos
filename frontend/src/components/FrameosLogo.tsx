import clsx from 'clsx'
import { assetUrl } from '../utils/assetUrl'

type FrameosLogoVariant = 'color' | 'white' | 'black' | 'white-colors'

const logoPaths: Record<FrameosLogoVariant, string> = {
  color: '/img/logo-2/logo.svg',
  white: '/img/logo-2/logo-white.svg',
  black: '/img/logo-2/logo-black.svg',
  'white-colors': '/img/logo-2/logo-white-colors.svg',
}

interface FrameosLogoProps {
  alt?: string
  className?: string
  variant?: FrameosLogoVariant
}

export function FrameosLogo({ alt = 'FrameOS', className, variant = 'color' }: FrameosLogoProps): JSX.Element {
  return <img src={assetUrl(logoPaths[variant])} className={clsx('object-contain', className)} alt={alt} />
}
