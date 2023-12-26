
import pixie
import httpclient

proc downloadImage*(url: string): Image =
  let client = newHttpClient()
  try:
    let content = client.getContent(url)
    result = decodeImage(content)
  finally:
    client.close()
