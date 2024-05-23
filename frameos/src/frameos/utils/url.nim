import httpclient

proc downloadUrl*(url: string): string =
  let client = newHttpClient(timeout = 30000)
  try:
    result = client.getContent(url)
  finally:
    client.close()
