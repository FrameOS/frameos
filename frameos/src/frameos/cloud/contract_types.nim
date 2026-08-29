## The types the generated cloud contract tables (contract_gen.nim) are made
## of. Kept in their own leaf module so the generator's output imports one
## thing and the validator (contract.nim) imports both.

type
  RuleKind* = enum
    rkBool, rkInt, rkNumber, rkString, rkObject, rkArray, rkMap, rkNull, rkAnyOf

  StringFormat* = enum
    sfNone, sfIanaZone, sfHtmlHexColor, sfGpioLabel

  Rule* = object
    ## One node of the rule language in docs/cloud-frames-contract.json.
    ## -1 on a length/count field means "no limit".
    kind*: RuleKind
    hasMin*, hasMax*: bool
    min*, max*: float
    intEnum*: seq[int]
    strEnum*: seq[string]
    minLen*: int = -1
    maxLen*: int = -1
    format*: StringFormat
    keys*: seq[KeyRule]       ## object: the allowed keys
    required*: seq[string]    ## object: keys that must be present
    minKeys*: int = 0         ## object: at least this many keys
    open*: bool               ## object: unknown keys are fine
    children*: seq[Rule]      ## array: [items]; map: [values]; anyOf: alternatives
    maxItems*: int = -1       ## array: max entries; map: max entries
    keyMinLen*: int = -1      ## map: key length bounds
    keyMaxLen*: int = -1

  KeyRule* = object
    name*: string
    rule*: Rule

  ProfileSpec* = object
    profile*: string
    since*: string            ## "" = every firmware version
    restart*: bool            ## applying it restarts the runtime / reboots the chip
    hasRule*: bool
    rule*: Rule               ## this profile's override of the setting's rule

  SettingSpec* = object
    key*: string
    rule*: Rule
    companion*: string        ## only valid next to this other key in the same push
    extraChecks*: seq[string] ## checks the language cannot express (hand-implemented)
    profiles*: seq[ProfileSpec]

  VerbSpec* = object
    verb*: string
    scope*: string            ## required scope, "" = none
    content*: bool            ## refused `backend_managed` when a backend owns the frame

  LimitSpec* = object
    name*: string
    profile*: string
    value*: int
