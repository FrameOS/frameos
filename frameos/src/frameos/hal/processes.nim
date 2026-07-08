## Child-process HAL.
##
## On Linux every child process goes through utils/process (serialized spawn,
## timeouts — see that module for why). Embedded targets have no processes at
## all: importing this module there is a compile-time error, which is the
## point — code that forks must stay out of the embedded dependency graph.

when defined(frameosEmbedded) or defined(frameosWasm):
  {.error: "frameos/hal/processes: child processes do not exist on embedded targets".}
else:
  import frameos/utils/process
  export process
