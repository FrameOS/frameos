import times
import frameos/types

type
  AppConfig* = object
    format*: string
    formatCustom*: string

  App* = ref object of AppRoot
    appConfig*: AppConfig

proc get*(self: App, context: ExecutionContext): string =
  result = now().format(case self.appConfig.format:
    of "custom": self.appConfig.formatCustom
    else: self.appConfig.format)
