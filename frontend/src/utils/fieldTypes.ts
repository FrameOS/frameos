export const fieldTypeToGetter: Record<string, string> = {
  integer: '.getInt()',
  string: '.getStr()',
  text: '.getStr()',
  boolean: '.getBool()',
  float: '.getFloat()',
  select: '.getStr()',
  json: '',
}
