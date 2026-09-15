## The IT8951 pixel payload goes over spidev as big-endian 16-bit words in
## transfers no larger than the kernel's default spidev buffer. The packing is
## pure (drivers/waveshare/it8951/spiPacking.nim) so the byte order and the
## chunk boundaries can be checked without Linux headers.

import std/unittest
import drivers/waveshare/it8951/spiPacking

suite "IT8951 SPI packing":
  test "words go out most significant byte first":
    var dest: array[8, uint8]
    let written = packWordsBigEndian([0x1234'u16, 0xABCD'u16, 0x00FF'u16], dest)
    check written == 6
    check dest[0 .. 5] == [0x12'u8, 0x34, 0xAB, 0xCD, 0x00, 0xFF]
    check dest[6] == 0 and dest[7] == 0

  test "a chunk never overruns the destination":
    var dest: array[4, uint8]
    let written = packWordsBigEndian([1'u16, 2, 3, 4, 5], dest)
    check written == 4
    check dest == [0'u8, 1, 0, 2]

  test "an empty source writes nothing":
    var dest: array[2, uint8]
    let empty: seq[uint16] = @[]
    check packWordsBigEndian(empty, dest) == 0

  test "the chunk limit matches spidev's default buffer":
    check spiMaxTransferBytes == 4096
    check spiMaxTransferWords * 2 == spiMaxTransferBytes
    var dest: array[spiMaxTransferBytes, uint8]
    var words = newSeq[uint16](spiMaxTransferWords + 10)
    for i in 0 ..< words.len:
      words[i] = uint16(i)
    check packWordsBigEndian(words, dest) == spiMaxTransferBytes
    check dest[^2] == uint8((spiMaxTransferWords - 1) shr 8)
    check dest[^1] == uint8((spiMaxTransferWords - 1) and 0xFF)
