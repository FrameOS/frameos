import frameos/types
import frameos/values

proc initApp*(keyword: string, node: DiagramNode, scene: FrameScene): AppRoot =
  case keyword:
  else: raise newException(ValueError, "Unknown app keyword: " & keyword)

proc setAppField*(keyword: string, app: AppRoot, field: string, value: Value) =
  case keyword:
  else: raise newException(ValueError, "Unknown app keyword: " & keyword)

proc runApp*(keyword: string, app: AppRoot, context: ExecutionContext) =
  case keyword:
  else: raise newException(Exception, "App '" & keyword & "' cannot be run; use get().")

proc getApp*(keyword: string, app: AppRoot, context: ExecutionContext): Value =
  case keyword:
  else: raise newException(ValueError, "Unknown app keyword: " & keyword)
