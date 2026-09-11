// Monaco model URIs built from scene-supplied names: node ids, app keywords,
// source file names and scene ids all come from scene JSON (store zips,
// imports, AI output). `monaco.Uri.parse` splits an unencoded `#` or `?`
// off into a fragment or query and throws or mis-decodes on a stray `%`, so
// two different files could share one model (and one file's edits land in
// the other) or a model could never be found again to dispose.

/** One URI path segment. */
export function monacoPathSegment(value: string | number): string {
  return encodeURIComponent(String(value))
}

/** A source file path: each segment encoded, the `/` separators kept so
 * relative imports between an app's files still resolve. */
export function monacoFilePath(file: string): string {
  return file.split('/').map(monacoPathSegment).join('/')
}

/** `inmemory://<root>/<segment>/…/<file>` with every scene-supplied part encoded. */
export function inmemoryModelPath(root: string, segments: (string | number)[], file: string): string {
  return `inmemory://${root}/${[...segments.map(monacoPathSegment), monacoFilePath(file)].join('/')}`
}
