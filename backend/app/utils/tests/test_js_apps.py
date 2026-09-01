from app.utils.js_apps import validate_js_source


def test_validate_js_source_accepts_typescript_jsx():
    assert (
        validate_js_source(
            "app.tsx",
            'const view = <text>ok</text>; export function get() { return "ok" }',
        )
        == []
    )


def test_validate_js_source_accepts_typescript_the_frame_parses():
    # The checker is the frame's own parser (quickts), so what passes here is
    # what runs there: enums, parameter properties, overloads and all.
    source = """enum Mode { Draft, Live }
class Repo {
  constructor(private readonly id: string) {}
  find(id: string): string;
  find(id: number): string;
  find(id: string | number): string { return String(id) }
}
export function get(app: { config: { mode?: Mode } }): string {
  return new Repo("x").find(app.config.mode ?? Mode.Draft)
}
"""
    assert validate_js_source("app.ts", source) == []


def test_validate_js_source_reports_syntax_error_location():
    errors = validate_js_source("app.ts", "export function get(app: any) { return ")

    assert errors
    # the file ends mid-statement: the parser stops at the end of input
    assert errors[0]["line"] == 1
    assert errors[0]["column"] > 1
    assert "unexpected" in errors[0]["error"].lower()


def test_validate_js_source_reports_multiline_location():
    source = """export function run(app: FrameOSApp, context: FrameOSContext): void {
  const stateKey = app.config.stateKey || 'jsLogicResult'

  app.log('JS logic app ran', { event: context.eve
nt, stateKey })
}
"""

    errors = validate_js_source("app.ts", source)

    assert errors
    assert errors[0]["line"] == 5
    assert errors[0]["column"] == 1
    assert "expecting '}'" in errors[0]["error"]


def test_validate_js_source_plain_js_keeps_javascript_meaning():
    # A .js file goes through the untouched parser: `f < a > (b)` is a
    # comparison there, and the pass that would read it as a generic call
    # is off.
    assert validate_js_source("app.js", "const f = () => 1, a = 1, b = 2; export const x = f < a > (b)") == []
