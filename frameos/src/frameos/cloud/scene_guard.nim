# Shared guard for provider-pushed scene payloads. Lives in its own leaf
# module (stdlib only) because both the cloud verb dispatcher
# (cloud/hub_client.nim, transport time) and the scene registry
# (frameos/scenes.nim, load time) consult it — scenes.nim cannot import
# hub_client, which imports it back.
import std/[json, strutils]

# Built-in apps a provider-pushed scene may not reference. Everything else on a
# managed frame reaches the network through utils/http_client, where
# `enforceLocalNetworkPolicy` denies private addresses; these two do not, so a
# `set_scenes` push naming them would walk straight around that chokepoint.
# Locally authored scenes are unaffected — this list is only consulted for
# payloads whose recorded source is the cloud.
#
# Derived by grepping src/apps for child-process spawning
# (`utils/process`, `hal/processes`, `runProcess`, `osproc`): those two files
# are the complete set on this branch. Legacy apps that call std/httpclient
# directly (apps/legacy/openai*) are not listed because they are not in the
# compiled registry (src/apps/apps.nim) and therefore cannot be reached by any
# keyword at all.
const CLOUD_REFUSED_APP_KEYWORDS* = [
  # apt-get install (privileged!) plus a headless Chromium pointed at a
  # configured URL: a package installer and an SSRF pivot in one node.
  "chromiumScreenshot",
  # ffmpeg -i <url>: another attacker-chosen target fetched by a child process
  # rather than by the bounded HTTP client.
  "rstpSnapshot",
]

proc refusedCloudAppKeyword*(scenes: JsonNode): string {.gcsafe.} =
  ## "" when the payload references no app from CLOUD_REFUSED_APP_KEYWORDS,
  ## otherwise the offending keyword. Cloud-pushed scenes only: a scene the
  ## local admin wrote may still use these apps. Checked twice on purpose —
  ## at transport time by the verb dispatcher, and again at load time for any
  ## persisted payload whose source is the cloud, so a file edited on disk or
  ## written before a keyword was added still cannot reach these apps.
  if scenes == nil or scenes.kind != JArray:
    return ""
  for scene in scenes:
    if scene == nil or scene.kind != JObject:
      continue
    let nodes = scene{"nodes"}
    if nodes == nil or nodes.kind != JArray:
      continue
    for node in nodes:
      if node == nil or node.kind != JObject:
        continue
      if node{"type"}.getStr("") != "app":
        continue
      let data = node{"data"}
      if data == nil or data.kind != JObject:
        continue
      let keyword = data{"keyword"}.getStr("")
      if keyword.len == 0:
        continue
      # Compare on the trailing segment ("data/rstpSnapshot" → "rstpSnapshot")
      # so a category rename cannot quietly reopen the hole.
      let leaf = keyword.rsplit('/', maxsplit = 1)[^1]
      for refused in CLOUD_REFUSED_APP_KEYWORDS:
        if cmpIgnoreCase(leaf, refused) == 0:
          return keyword
  ""
