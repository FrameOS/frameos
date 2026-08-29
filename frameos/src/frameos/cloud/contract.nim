## The cloud verb contract, as the Linux runtime reads it.
##
## docs/cloud-frames-contract.json is the source of truth for which
## `set_settings` keys a device accepts, from which firmware version, with
## which value rules; generate_cloud_contract.py turns it into contract_gen.nim
## (and the ESP32 / cloud / SPA tables). This module is the ~100-line walker
## of that table plus the two checks the rule language cannot express
## (`extraChecks` in the contract). docs/cloud-frames-fixtures.json holds the
## cases every implementation must agree on.

import std/[json, strutils]

import ./contract_gen
import ./contract_types

export contract_types
export CloudContractSettings, CloudContractVerbs, CloudContractLimits

const LinuxProfile* = "linux"

proc findSetting(key: string): int =
  for i, spec in CloudContractSettings:
    if spec.key == key:
      return i
  -1

proc findProfile(spec: SettingSpec, profile: string): int =
  for i, p in spec.profiles:
    if p.profile == profile:
      return i
  -1

proc profileAllowlist*(profile: string): seq[string] =
  ## Every key this profile accepts, in contract order.
  for spec in CloudContractSettings:
    if spec.findProfile(profile) >= 0:
      result.add(spec.key)

proc profileRestartKeys*(profile: string): seq[string] =
  ## The keys whose application restarts the runtime / reboots the chip.
  for spec in CloudContractSettings:
    let p = spec.findProfile(profile)
    if p >= 0 and spec.profiles[p].restart:
      result.add(spec.key)

proc settingSince*(profile, key: string): string =
  ## The first firmware version of `profile` that knows `key`; "" for every
  ## version. Raises KeyError when the profile does not take the key at all.
  let s = findSetting(key)
  if s < 0:
    raise newException(KeyError, key)
  let p = CloudContractSettings[s].findProfile(profile)
  if p < 0:
    raise newException(KeyError, key)
  CloudContractSettings[s].profiles[p].since

proc contractLimit*(name, profile: string): int =
  for limit in CloudContractLimits:
    if limit.name == name and limit.profile == profile:
      return limit.value
  raise newException(KeyError, name & "/" & profile)

proc contractVerb*(verb: string): tuple[known: bool, scope: string, content: bool] =
  for spec in CloudContractVerbs:
    if spec.verb == verb:
      return (true, spec.scope, spec.content)
  (false, "", false)

# ------------------------------------------------------------- formats

proc isIanaZone*(value: string): bool =
  ## ^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+)*$ — the shape the device
  ## console and fos_tz accept; the tzdata lookup is what rejects an unknown
  ## but well-formed name later.
  if value.len == 0 or not value[0].isAlphaAscii():
    return false
  var segmentLen = 0
  for i, ch in value:
    if ch == '/':
      if i == 0 or segmentLen == 0 or i == value.high:
        return false
      segmentLen = 0
    elif ch.isAlphaNumeric() or ch in {'_', '+', '-'}:
      inc segmentLen
    else:
      return false
  true

proc isHtmlHexColor*(value: string): bool =
  ## "#rrggbb" only.
  if value.len != 7 or value[0] != '#':
    return false
  for ch in value[1 .. ^1]:
    if ch notin {'0'..'9', 'a'..'f', 'A'..'F'}:
      return false
  true

proc isGpioLabel*(value: string): bool =
  ## 1..32 characters after trimming, no ':' (the firmware's spec separator)
  ## and no newline.
  let trimmed = value.strip()
  trimmed.len in 1 .. 32 and ':' notin value and '\n' notin value

proc matchesFormat(format: StringFormat, value: string): bool =
  case format
  of sfNone: true
  of sfIanaZone: isIanaZone(value)
  of sfHtmlHexColor: isHtmlHexColor(value)
  of sfGpioLabel: isGpioLabel(value)

# ------------------------------------------------------------- the walker

proc validateRule*(rule: Rule, value: JsonNode): bool =
  ## Does `value` satisfy `rule`? Purely structural — the extra checks are
  ## the caller's (validateContractSetting).
  if value == nil:
    return false
  case rule.kind
  of rkBool:
    value.kind == JBool
  of rkNull:
    value.kind == JNull
  of rkInt:
    if value.kind != JInt:
      return false
    let n = value.getInt()
    if rule.hasMin and n.float < rule.min: return false
    if rule.hasMax and n.float > rule.max: return false
    if rule.intEnum.len > 0 and n notin rule.intEnum: return false
    true
  of rkNumber:
    if value.kind notin {JInt, JFloat}:
      return false
    let n = value.getFloat()
    if rule.hasMin and n < rule.min: return false
    if rule.hasMax and n > rule.max: return false
    true
  of rkString:
    if value.kind != JString:
      return false
    let s = value.getStr()
    if rule.minLen >= 0 and s.len < rule.minLen: return false
    if rule.maxLen >= 0 and s.len > rule.maxLen: return false
    if rule.strEnum.len > 0 and s notin rule.strEnum: return false
    matchesFormat(rule.format, s)
  of rkObject:
    if value.kind != JObject:
      return false
    if value.len < rule.minKeys:
      return false
    for key in value.keys:
      var known = false
      for keyRule in rule.keys:
        if keyRule.name == key:
          known = true
          if not validateRule(keyRule.rule, value[key]):
            return false
          break
      if not known and not rule.open:
        return false
    for required in rule.required:
      if not value.hasKey(required):
        return false
    true
  of rkArray:
    if value.kind != JArray:
      return false
    if rule.maxItems >= 0 and value.len > rule.maxItems:
      return false
    for item in value:
      if not validateRule(rule.children[0], item):
        return false
    true
  of rkMap:
    if value.kind != JObject:
      return false
    if rule.maxItems >= 0 and value.len > rule.maxItems:
      return false
    for key in value.keys:
      if rule.keyMinLen >= 0 and key.len < rule.keyMinLen: return false
      if rule.keyMaxLen >= 0 and key.len > rule.keyMaxLen: return false
      if not validateRule(rule.children[0], value[key]):
        return false
    true
  of rkAnyOf:
    for alternative in rule.children:
      if validateRule(alternative, value):
        return true
    false

proc extraChecks(key: string, value: JsonNode): bool =
  ## The checks docs/cloud-frames-contract.json lists under `extraChecks`:
  ## cross-field rules the language does not express. Implemented in every
  ## validator by hand; the fixtures pin them.
  case key
  of "palette":
    let colors = value{"colors"}
    let names = value{"colorNames"}
    names == nil or (colors != nil and names.len == colors.len)
  of "gpio_buttons":
    var seen: seq[int] = @[]
    for button in value:
      let pin = button{"pin"}.getInt(-1)
      if pin in seen:
        return false
      seen.add(pin)
    true
  else:
    true

proc validateContractSetting*(profile, key: string, value: JsonNode): bool =
  ## Is `value` acceptable for `key` on `profile`? False for a key the
  ## profile does not take at all.
  let s = findSetting(key)
  if s < 0:
    return false
  let spec = CloudContractSettings[s]
  let p = spec.findProfile(profile)
  if p < 0:
    return false
  let rule = if spec.profiles[p].hasRule: spec.profiles[p].rule else: spec.rule
  validateRule(rule, value) and extraChecks(key, value)

proc checkContractSettings*(profile: string, settings: JsonNode): string =
  ## The whole-push verdict a device gives a `set_settings` object: "" when
  ## every key is allowed and valid, otherwise the error token — one unknown
  ## key or one bad value refuses the whole push, so provider and device
  ## never disagree about what got set. Companion keys (timezone_data) are
  ## refused without the key they ride on.
  if settings == nil or settings.kind != JObject or settings.len == 0:
    return "invalid_settings"
  for key in settings.keys:
    let s = findSetting(key)
    if s < 0 or CloudContractSettings[s].findProfile(profile) < 0:
      return "setting_not_allowed"
  for key in settings.keys:
    if not validateContractSetting(profile, key, settings[key]):
      return "invalid_settings"
    let companion = CloudContractSettings[findSetting(key)].companion
    if companion.len > 0 and not settings.hasKey(companion):
      return "invalid_settings"
  ""
