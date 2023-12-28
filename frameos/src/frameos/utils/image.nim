
import pixie
import httpclient

proc downloadImage*(url: string): Image =
  let client = newHttpClient()
  try:
    let content = client.getContent(url)
    result = decodeImage(content)
  finally:
    client.close()

proc rotate90Degrees*(image: Image): Image {.raises: [PixieError].} =
  let rotated = newImage(image.height, image.width)
  for y in 0 ..< rotated.height:
    for x in 0 ..< rotated.width:
      rotated.data[rotated.dataIndex(x, y)] =
        image.data[image.dataIndex(y, image.height - x - 1)]
  return rotated

proc rotate180Degrees*(image: Image): Image {.raises: [PixieError].} =
  let rotated = newImage(image.width, image.height)
  for y in 0 ..< rotated.height:
    for x in 0 ..< rotated.width:
      rotated.data[rotated.dataIndex(x, y)] =
        image.data[image.dataIndex(image.width - x - 1, image.height - y - 1)]
  return rotated

proc rotate270Degrees*(image: Image): Image {.raises: [PixieError].} =
  let rotated = newImage(image.height, image.width)
  for y in 0 ..< rotated.height:
    for x in 0 ..< rotated.width:
      rotated.data[rotated.dataIndex(x, y)] =
        image.data[image.dataIndex(image.width - y - 1, x)]
  return rotated
