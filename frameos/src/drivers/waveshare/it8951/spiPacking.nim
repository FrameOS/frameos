## Wire packing for the IT8951 SPI link.
##
## The IT8951 takes its pixel payload as 16-bit words, most significant byte
## first, streamed inside one "write data" transaction. Over spidev every
## transfer is an ioctl, so the words are packed into byte chunks and each
## chunk goes out as a single transfer instead of one syscall per byte. This
## module is pure so the packing can be unit tested without Linux headers.

const
  ## spidev's default `bufsiz` module parameter: the largest single transfer
  ## the kernel accepts without `spidev.bufsiz=` on the command line.
  spiMaxTransferBytes* = 4096
  spiMaxTransferWords* = spiMaxTransferBytes div 2

proc packWordsBigEndian*(words: openArray[uint16]; dest: var openArray[uint8]): int =
  ## Writes `words` into `dest` as big-endian byte pairs and returns the number
  ## of bytes written. Stops at whichever of the two buffers fills first.
  let count = min(words.len, dest.len div 2)
  for i in 0 ..< count:
    dest[i * 2] = uint8((words[i] shr 8) and 0xFF)
    dest[i * 2 + 1] = uint8(words[i] and 0xFF)
  count * 2
