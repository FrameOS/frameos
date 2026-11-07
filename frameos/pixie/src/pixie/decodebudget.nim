## Runtime memory budget for image decoding.
##
## Decoders consult `decodeBudgetBytes` before allocating image-sized
## buffers (coefficient blocks, channel masks, inflate output, pixel seqs)
## and raise a catchable PixieError when a decode would exceed it. The
## budget covers decode *intermediates plus output* for a single decode
## call, not process-wide usage.
##
## 0 means unlimited (upstream pixie behaviour). Embedded builds default
## to a conservative budget; hosts default to unlimited until the
## application calls `setDecodeBudgetBytes` with a live value derived from
## available memory.

when defined(frameosEmbedded):
  const defaultDecodeBudgetBytes = 10 * 1024 * 1024
else:
  const defaultDecodeBudgetBytes = 0

var decodeBudget {.threadvar.}: int
var decodeBudgetInitialized {.threadvar.}: bool

proc decodeBudgetBytes*(): int {.inline, raises: [].} =
  ## Current per-decode memory budget in bytes; 0 = unlimited.
  if not decodeBudgetInitialized:
    decodeBudget = defaultDecodeBudgetBytes
    decodeBudgetInitialized = true
  decodeBudget

proc setDecodeBudgetBytes*(bytes: int) {.raises: [].} =
  ## Sets the per-decode memory budget; 0 = unlimited. Refresh this from
  ## live available memory before heavy decodes for best results.
  decodeBudget = max(0, bytes)
  decodeBudgetInitialized = true

proc overDecodeBudget*(bytes: int64): bool {.inline, raises: [].} =
  ## True when an allocation plan of `bytes` exceeds the current budget.
  let budget = decodeBudgetBytes()
  budget > 0 and bytes > budget.int64

## A second, independent limit: the largest SINGLE buffer a decode may
## allocate. The plan budget above answers "can these buffers coexist" —
## a sum over many separate allocations — which is the right question on a
## heap that is merely short, and the wrong one on a heap that is
## fragmented: an ESP32 with 8.6 MB of PSRAM free and a 6 MB largest block
## passed a 5.8 MB plan whose luma channel was one 3.75 MB allocation, then
## died in malloc. Decoders clamp their largest buffer to this and refuse
## (catchably, "memory budget" in the message) when even the clamped plan
## cannot fit. 0 = unlimited.

var
  decodeContiguousBudget {.threadvar.}: int
  decodeContiguousProvider {.threadvar.}: proc(): int {.nimcall, raises: [].}

proc decodeContiguousBudgetBytes*(): int {.raises: [].} =
  ## Largest single allocation a decode may make; 0 = unlimited.
  if not decodeContiguousProvider.isNil:
    decodeContiguousBudget = max(0, decodeContiguousProvider())
    decodeContiguousProvider = nil
  decodeContiguousBudget

proc setDecodeContiguousBudgetBytes*(bytes: int) {.raises: [].} =
  ## Sets the largest-single-allocation budget; 0 = unlimited. Feed it the
  ## largest free block of the heap the decode buffers come from.
  decodeContiguousBudget = max(0, bytes)
  decodeContiguousProvider = nil

proc setDecodeContiguousBudgetProvider*(
  provider: proc(): int {.nimcall, raises: [].}
) {.raises: [].} =
  ## Sets the largest-single-allocation budget to what `provider` answers
  ## the first time a decode asks for it, and keeps that answer until the
  ## next set. For a heap whose largest free block is costly to measure (an
  ## ESP32 walks every block for it, half a millisecond with a few hundred),
  ## refreshed before every render of an animation that mostly decodes
  ## nothing.
  decodeContiguousProvider = provider

proc overContiguousBudget*(bytes: int64): bool {.inline, raises: [].} =
  ## True when one allocation of `bytes` exceeds the contiguous budget.
  let budget = decodeContiguousBudgetBytes()
  budget > 0 and bytes > budget.int64
