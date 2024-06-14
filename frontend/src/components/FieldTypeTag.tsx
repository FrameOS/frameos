import { AppConfigFieldType, FieldType, toFieldType } from '../types'
import { Tag, TagProps } from './Tag'

export const typeColors: Record<FieldType, TagProps['color']> = {
  string: 'blue',
  float: 'red',
  integer: 'orange',
  boolean: 'gray',
  color: 'secondary',
  json: 'secondary',
  node: 'secondary',
  scene: 'secondary',
  image: 'primary',
}

export interface FieldTypeTagProps {
  type: FieldType | AppConfigFieldType
}

export function FieldTypeTag({ type }: FieldTypeTagProps): JSX.Element {
  console.log({ type })
  const _type = toFieldType(type)
  return <Tag color={typeColors[_type]}>{_type}</Tag>
}
