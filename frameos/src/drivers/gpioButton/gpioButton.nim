import json, options, strformat, os
{.push header: "<gpiod.h>".}
import gpiod
{.pop.}

from frameos/types import FrameConfig, FrameOS, Logger, FrameOSDriver

type Driver* = ref object of FrameOSDriver
  logger: Logger

proc log*(self: Driver, message: string) =
  self.logger.log(%*{"event": "driver:gpioButton", "message": message})

proc error*(self: Driver, message: string) =
  self.logger.log(%*{"event": "driver:gpioButton", "error": message})



# proc GPIOD_Export()
# {
#     char buffer[NUM_MAXBUF];
#     FILE *fp;

#     fp = popen("cat /proc/cpuinfo | grep 'Raspberry Pi 5'", "r");
#     if (fp == NULL) {
#         GPIOD_Debug("It is not possible to determine the model of the Raspberry PI\n");
#         return -1;
#     }

#     if(fgets(buffer, sizeof(buffer), fp) != NULL)
#     {
#         gpiochip = gpiod_chip_open("/dev/gpiochip4");
#         if (gpiochip == NULL)
#         {
#             GPIOD_Debug( "gpiochip4 Export Failed\n");
#             return -1;
#         }
#     }
#     else
#     {
#         gpiochip = gpiod_chip_open("/dev/gpiochip0");
#         if (gpiochip == NULL)
#         {
#             GPIOD_Debug( "gpiochip0 Export Failed\n");
#             return -1;
#         }
#     }


#     return 0;
# }




proc init*(frameOS: FrameOS): Driver =
  result = Driver(
    name: "gpioButton",
    logger: frameOS.logger
  )
  let self = result
  let gpiochip = gpiod_chip_open("/dev/gpiochip4")
  let gpioline = gpiod_chip_get_line_info(gpiochip, 24.cuint)
  let ret = gpiod_line_info_get_name(gpioline)
  self.log($ret)

  # self.log(&"Exporting GPIO button driver: {resp}")
  # # [5, 6, 16, 24], ['A', 'B', 'C', 'D']
  # var i = 0
  # while i < 60:
  #   let read = GPIOD_Read(24)
  #   self.log(&"Read status: {read}")
  #   sleep(500)
  #   i += 1
