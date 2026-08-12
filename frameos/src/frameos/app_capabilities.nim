## Per-port execution capabilities an app declares in its config.json.
##
## The planner (frameos/planner.nim) reads these to decide how a value moves
## across an edge; nothing here is visible in the editor or in scene JSON.
## Generated into src/apps/apps.nim by backend/app/codegen/apps_nim.py — an app
## that declares nothing gets `NoAppCapabilities`, which means "materialized",
## the floor every edge always supports.
##
## See docs/value-pipeline.md for the protocol table and the planner rules.

type
  FieldConstraint* = object
    ## `field` must statically resolve to one of `allowed` for the capability
    ## to apply. An unset field resolves to its config.json default.
    field*: string
    allowed*: seq[string]

  FieldMatch* = object
    field*: string
    value*: string

  ProvidesTargetSpec* = object
    ## An input port that can hand its producer a target to write into,
    ## because this app is going to draw that input over the whole target
    ## anyway. Declared on a field in config.json.
    input*: string
    ## Config field carrying the fit (cover/contain/stretch) the producer
    ## should use. Resolved from config, or from a wired state node at render
    ## time; anything else disqualifies.
    fitFrom*: string
    fits*: seq[string]
    requireStatic*: seq[FieldConstraint]
    ## Extra constraints that apply only when the terminal producer COMPOSITES
    ## into the target (a dynamic JS app drawing source-over) instead of
    ## overwriting every pixel it fits. A compositing producer on the live
    ## canvas is only equivalent to a materialized draw when the consumer's own
    ## draw is a plain composite too — an `overwrite` blend of a possibly
    ## transparent materialized image erases what a composite leaves visible.
    compositingRequireStatic*: seq[FieldConstraint]
    ## Fields that must be neither configured nor wired — typically the
    ## optional "draw on top of this image instead" input.
    requireUnset*: seq[string]
    ## Shapes where an app-owned scratch target would NOT produce the same
    ## pixels as a materialized value, and so must stay unfused. Each entry is
    ## a set of field/value pairs that all have to match. The live-canvas tier
    ## is unaffected: it does not carry margins of its own.
    ownedTargetExcludes*: seq[seq[FieldMatch]]

  IntoTargetSpec* = object
    ## An output port whose app writes into a caller-supplied image with the
    ## requested fit, instead of returning a freshly allocated one.
    output*: string
    fits*: seq[string]
    requireStatic*: seq[FieldConstraint]
    requireUnset*: seq[string]
    ## Fields whose statically-resolved color must be fully opaque for the
    ## capability to apply. The "output is opaque given these fields" promise:
    ## a generator that fills every pixel of its target with opaque paint may
    ## claim the live canvas, because a set of opaque pixels and a composite of
    ## them are the same picture. A semi-transparent fill is a set where the
    ## materialized floor composites — "tint the photo" must never erase the
    ## photo — so it stays on the floor. A wired color never resolves and
    ## never satisfies this, like requireStatic.
    requireOpaqueColor*: seq[string]

  ForwardsTargetSpec* = object
    ## An output port that passes a target request upstream to `input` and
    ## mutates the result in place, returning the very same image.
    output*: string
    input*: string
    requireStatic*: seq[FieldConstraint]

  ForwardsBoundsSpec* = object
    ## An output port that passes the consumer's useful-resolution *bounds*
    ## upstream to `input` — the requestedBounds protocol, for transformers
    ## that cannot forward a target (their output is not their input's
    ## buffer) but whose geometry is still statically knowable.
    output*: string
    input*: string
    ## The field that decides how bounds transform (a rotation degree).
    ## Statically resolving to a `swapValues` entry swaps width and height;
    ## a `keepValues` entry passes them unchanged; anything else — an
    ## arbitrary angle, a wired field — refuses the plan, never guesses.
    boundsField*: string
    swapValues*: seq[string]
    keepValues*: seq[string]
    ## Or: replace the bounds outright with these fields' static values (a
    ## resize's own dimensions — what is downstream no longer matters).
    widthFrom*: string
    heightFrom*: string
    ## Fields whose statically-resolved maximum multiplies the bounds on the
    ## way up (a zoom factor: the crop shown at zoom Z uses Z times the
    ## consumer's resolution from the source). The floor is 1.0 — a
    ## multiplier never shrinks a bound — and a wired field refuses, never
    ## guesses.
    multiplyFrom*: seq[string]

  RequestsBoundsSpec* = object
    ## An input port whose consumer draws it at target resolution times a
    ## static multiplier, but can never hand its producer a target — its
    ## draw is a per-render crop, not a fit. Bounds-only participation in
    ## the pipeline (render/zoomPan): the planner starts a requestedBounds
    ## walk here exactly as it does at a `providesTarget` consumer whose
    ## edge stayed materialized.
    input*: string
    ## Typically the optional "draw onto this image instead" input: its size,
    ## not the canvas's, would define the useful resolution.
    requireUnset*: seq[string]
    ## Same contract as the ForwardsBoundsSpec field above.
    multiplyFrom*: seq[string]

  AppCapabilities* = object
    providesTarget*: seq[ProvidesTargetSpec]
    intoTarget*: seq[IntoTargetSpec]
    forwardsTarget*: seq[ForwardsTargetSpec]
    forwardsBounds*: seq[ForwardsBoundsSpec]
    requestsBounds*: seq[RequestsBoundsSpec]
    ## config.json defaults for every field any of the specs above refers to,
    ## so the planner can tell "unset" from "explicitly set to the default".
    fieldDefaults*: seq[FieldMatch]

const NaturalFit* = "natural"
  ## A producer that fills exactly the target it is handed, at that size, with
  ## no fitting of its own — a generator rather than a decoder.
  ##
  ## It is worth its own value because it widens what a consumer can offer. A
  ## decoder needs to be told cover/contain/stretch, so only those placements
  ## can hand it a target. A source that comes back at exactly the target size
  ## draws identically under *every* placement — `center`, `top-left` and
  ## `cover` all reduce to the same 1:1 draw — so the placement stops mattering
  ## and only the offsets and the blend still do.

const NoAppCapabilities* = AppCapabilities()

proc isEmpty*(caps: AppCapabilities): bool =
  caps.providesTarget.len == 0 and caps.intoTarget.len == 0 and
    caps.forwardsTarget.len == 0 and caps.forwardsBounds.len == 0 and
    caps.requestsBounds.len == 0

proc fieldDefault*(caps: AppCapabilities, field: string): string =
  for entry in caps.fieldDefaults:
    if entry.field == field:
      return entry.value
  ""
