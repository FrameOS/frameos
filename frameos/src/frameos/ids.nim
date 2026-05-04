import std/[hashes, json]

type
  NodeId* = distinct int
  SceneId* = distinct string

proc `==`*(x, y: NodeId): bool = x.int == y.int
proc `==`*(x: int, y: NodeId): bool = x == y.int
proc `==`*(x: NodeId, y: int): bool = x.int == y
proc `$`*(x: NodeId): string = $(x.int)
proc `%`*(x: NodeId): JsonNode = %(x.int)

proc hash*(x: SceneId): Hash = x.string.hash
proc `==`*(x, y: SceneId): bool = x.string == y.string
proc `$`*(x: SceneId): string = x.string
proc `%`*(x: SceneId): JsonNode = %*(x.string)
