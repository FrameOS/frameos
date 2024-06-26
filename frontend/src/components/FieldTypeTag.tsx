import { AppConfigFieldType, FieldType, toFieldType } from '../types'
import { Tag, TagProps } from './Tag'

export const typeColors: Record<FieldType, TagProps['color']> = {
  string: 'blue',
  float: 'teal',
  integer: 'teal',
  boolean: 'gray',
  color: 'orange',
  json: 'secondary',
  node: 'secondary',
  scene: 'secondary',
  image: 'red',
}

export interface FieldTypeTagProps {
  type: FieldType | AppConfigFieldType
  className?: string
}

export function FieldTypeTag({ type, className }: FieldTypeTagProps): JSX.Element {
  const _type = toFieldType(type)
  return (
    <Tag color={typeColors[_type]} className={className}>
      {_type}
    </Tag>
  )
}
