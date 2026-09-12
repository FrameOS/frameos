import pixie
import times
import options
import json
import strutils
import std/uri
import chrono
import frameos/apps
import frameos/types
import frameos/utils/http_client

# FostPlus/RecycleApp.be replaced the old recycle-public/app API (which gated every
# call behind a rotating, scraped `x-secret`) with this recyclecms public API. It needs
# no token exchange at all — a single `x-consumer` header is enough. No secret to ship.
const API_ENDPOINT = "https://api.fostplus.be/recyclecms/public/v1"
const USER_AGENT = "Mozilla/5.0"
const X_CONSUMER = "recycleapp.be"

type
  BeRecycleAuthenticateHook* = proc(self: App)
  BeRecycleFetchCollectionsHook* = proc(self: App, fromDate: string, toDate: string): JsonNode

  AppConfig* = object
    exportFrom*: string
    exportUntil*: string
    exportCount*: int
    language*: string
    streetName*: string
    number*: int
    postalCode*: int

  App* = ref object of AppRoot
    appConfig*: AppConfig
    headers: seq[SimpleHttpHeader]

  AddressIds = object
    zip: string
    street: string
    housenumber: int

var
  beRecycleAuthenticateHook*: BeRecycleAuthenticateHook = nil
  beRecycleFetchCollectionsHook*: BeRecycleFetchCollectionsHook = nil

proc queryParam(value: string): string =
  ## Percent-encodes one query value. Street names carry spaces and accents;
  ## the runtime's HTTP client refuses a request line with either in it.
  encodeUrl(value, usePlus = false)

proc zipcodesUrl*(postalCode: int): string =
  API_ENDPOINT & "/zipcodes?q=" & queryParam($postalCode)

proc streetsUrl*(streetName: string, zipId: string): string =
  API_ENDPOINT & "/streets?q=" & queryParam(streetName) & "&zipcodes=" & queryParam(zipId)

proc collectionsUrl*(zipId: string, streetId: string, houseNumber: int,
                     fromDate: string, toDate: string): string =
  API_ENDPOINT & "/collections?zipcodeId=" & queryParam(zipId) &
    "&streetId=" & queryParam(streetId) &
    "&houseNumber=" & queryParam($houseNumber) &
    "&fromDate=" & queryParam(fromDate) &
    "&untilDate=" & queryParam(toDate) & "&size=100"

proc fetchBody(self: App, url: string, httpMethod = "GET", body = ""): string =
  let response = boundedRequestWithHeaders(url,
    httpMethod = httpMethod,
    body = body,
    headers = self.headers,
    maxBytes = self.maxHttpResponseBytes())
  if response.code >= 400:
    raise newException(IOError, "HTTP " & response.status & ": " & response.body)
  response.body

proc authenticate(self: App) =
  ## The recyclecms public API has no token exchange: the `x-consumer` header alone
  ## authorises every call. This just attaches the headers reused by later requests.
  self.headers = @[
    (name: "User-Agent", value: USER_AGENT),
    (name: "x-consumer", value: X_CONSUMER),
  ]

proc fetchAddressIds(self: App): AddressIds =
  let url = zipcodesUrl(self.appConfig.postalCode)
  let zipResp = self.fetchBody(url)
  let zipJson = parseJson(zipResp)
  var zipId = ""

  for item in zipJson["items"].items:
    if item["code"].getStr.parseInt == self.appConfig.postalCode:
      zipId = item["id"].getStr
      break

  if zipId == "":
    raise newException(ValueError, "Could not find the right zip code.")

  let streetUrl = streetsUrl(self.appConfig.streetName, zipId)
  let streetResp = self.fetchBody(streetUrl)
  let streetJson = parseJson(streetResp)
  var streetId = ""

  for item in streetJson["items"].items:
    if self.appConfig.streetName == item{"name"}.getStr:
      streetId = item["id"].getStr
      break

  if streetId == "":
    raise newException(ValueError, "Could not find the right street name.")
  result = AddressIds(zip: zipId, street: streetId, housenumber: self.appConfig.number)

proc fetchCollections(self: App, addressIds: AddressIds, fromDate: string, toDate: string): JsonNode =
  let url = collectionsUrl(addressIds.zip, addressIds.street, addressIds.housenumber, fromDate, toDate)
  let collectionResp = self.fetchBody(url)
  let collections = parseJson(collectionResp)

  if collections.hasKey("items"):
    return collections
  else:
    raise newException(ValueError, "Something went wrong while fetching collections.")

proc collectionsToEvents*(self: App, collections: JsonNode): seq[JsonNode] =
  let timezone = if self.frameConfig.timeZone != "": self.frameConfig.timeZone else: "UTC"
  var events: seq[JsonNode] = @[]
  for item in collections["items"].items:
    let date = item["timestamp"].getStr.split("T")[0]
    let event = %*{
      "summary": "Trash: " & item{"fraction"}{"name"}{self.appConfig.language}.getStr,
      "startTime": date & "T08:00:00",
      "endTime": date & "T08:15:00",
      "timezone": timezone,
    }
    events.add(event)
  return events

proc get*(self: App, context: ExecutionContext): JsonNode =
  result = %*[]
  let timezone = if self.frameConfig.timeZone != "": self.frameConfig.timeZone else: "UTC"
  let startTs = if self.appConfig.exportFrom == "": epochTime().Timestamp
                else: parseTs("{year/4}-{month/2}-{day/2}", self.appConfig.exportFrom, timezone)
  let endTs = if self.appConfig.exportUntil == "": (epochTime() + 366 * 24 * 60 * 60).Timestamp
              else: parseTs("{year/4}-{month/2}-{day/2}", self.appConfig.exportUntil, timezone)
  let startDay = startTs.format("{year/4}-{month/2}-{day/2}", timezone)
  let endDay = endTs.format("{year/4}-{month/2}-{day/2}", timezone)

  self.log("Preparing request headers...")
  if beRecycleAuthenticateHook == nil:
    self.authenticate()
  else:
    beRecycleAuthenticateHook(self)

  var collections: JsonNode
  self.log("Fetching collections...")
  if beRecycleFetchCollectionsHook == nil:
    self.log("Fetching address IDs...")
    let addressIds = self.fetchAddressIds()
    collections = self.fetchCollections(addressIds, startDay, endDay)
  else:
    collections = beRecycleFetchCollectionsHook(self, startDay, endDay)

  self.log(%*{"event": "reply", "eventsInRange": len(collections)})
  self.log("Converting collections to events...")
  let events = self.collectionsToEvents(collections)
  return %*(events)
