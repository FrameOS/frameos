import pixie
import times
import options
import json
import strutils
import chrono
import httpclient
import frameos/apps
import frameos/types

const API_ENDPOINT = "https://api.fostplus.be/recycle-public/app/v1"
const USER_AGENT = "Mozilla/5.0"
const X_CONSUMER = "recycleapp.be"
const X_SECRET = "Op2tDi2pBmh1wzeC5TaN2U3knZan7ATcfOQgxh4vqC0mDKmnPP2qzoQusmInpglfIkxx8SZrasBqi5zgMSvyHggK9j6xCQNQ8xwPFY2o03GCcQfcXVOyKsvGWLze7iwcfcgk2Ujpl0dmrt3hSJMCDqzAlvTrsvAEiaSzC9hKRwhijQAFHuFIhJssnHtDSB76vnFQeTCCvwVB27DjSVpDmq8fWQKEmjEncdLqIsRnfxLcOjGIVwX5V0LBntVbeiBvcjyKF2nQ08rIxqHHGXNJ6SbnAmTgsPTg7k6Ejqa7dVfTmGtEPdftezDbuEc8DdK66KDecqnxwOOPSJIN0zaJ6k2Ye2tgMSxxf16gxAmaOUqHS0i7dtG5PgPSINti3qlDdw6DTKEPni7X0rxM"

type
  AppConfig* = object
    exportFrom*: string
    exportUntil*: string
    exportCount*: int
    language*: string
    streetName*: string
    number*: int
    postalCode*: int
    xSecret*: string

  App* = ref object of AppRoot
    appConfig*: AppConfig
    headers: HttpHeaders
    expiresAt: string

  AddressIds = object
    zip: string
    street: string
    housenumber: int

proc authenticate(self: App) =
  self.headers = newHttpHeaders([
    ("User-Agent", USER_AGENT),
    ("x-consumer", X_CONSUMER),
    ("x-secret", if self.appConfig.xSecret != "": self.appConfig.xSecret else: X_SECRET)
  ])
  var client = newHttpClient(headers = self.headers)
  try:
    let url = API_ENDPOINT & "/access-token"
    let atResp = client.getContent(url)
    let atRespJson = parseJson(atResp)
    if atRespJson.hasKey("accessToken"):
      self.headers.add("Authorization", atRespJson["accessToken"].getStr())
      # TODO: refetch if expired
      self.expiresAt = atRespJson["expiresAt"].getStr()
    else:
      raise newException(ValueError, "Error occurred while requesting access-token.")
  finally:
    client.close()

proc fetchAddressIds(self: App): AddressIds =
  var client = newHttpClient(headers = self.headers)
  try:
    let url = API_ENDPOINT & "/zipcodes?q=" & $self.appConfig.postalCode
    let zipResp = client.getContent(url)
    let zipJson = parseJson(zipResp)
    var zipId = ""

    for item in zipJson["items"].items:
      if item["code"].getStr.parseInt == self.appConfig.postalCode:
        zipId = item["id"].getStr
        break

    if zipId == "":
      raise newException(ValueError, "Could not find the right zip code.")

    let streetUrl = API_ENDPOINT & "/streets?q=" & self.appConfig.streetName & "&zipcodes=" & zipId
    let streetResp = client.postContent(streetUrl, "")
    let streetJson = parseJson(streetResp)
    var streetId = ""

    for item in streetJson["items"].items:
      if self.appConfig.streetName == item{"name"}.getStr:
        streetId = item["id"].getStr
        break

    if streetId == "":
      raise newException(ValueError, "Could not find the right street name.")
    result = AddressIds(zip: zipId, street: streetId, housenumber: self.appConfig.number)
  finally:
    client.close()

proc fetchCollections(self: App, addressIds: AddressIds, fromDate: string, toDate: string): JsonNode =
  var client = newHttpClient(headers = self.headers)
  try:
    let url = API_ENDPOINT & "/collections?zipcodeId=" & addressIds.zip & "&streetId=" & addressIds.street &
        "&houseNumber=" & $addressIds.housenumber & "&fromDate=" & fromDate & "&untilDate=" & toDate & "&size=200"
    let collectionResp = client.getContent(url)
    let collections = parseJson(collectionResp)

    if collections.hasKey("items"):
      return collections
    else:
      raise newException(ValueError, "Something went wrong while fetching collections.")
  finally:
    client.close()

proc collectionsToEvents(self: App, collections: JsonNode): seq[JsonNode] =
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

  self.log("Authenticating...")
  self.authenticate()
  self.log("Fetching address IDs...")
  let addressIds = self.fetchAddressIds()
  self.log("Fetching collections...")
  let collections = self.fetchCollections(addressIds, startDay, endDay)
  self.log(%*{"event": "reply", "eventsInRange": len(collections)})
  self.log("Converting collections to events...")
  let events = self.collectionsToEvents(collections)
  return %*(events)
