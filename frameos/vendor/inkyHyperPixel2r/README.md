At present this is the most fool proof way to turn the display on and off.

The GPIO for backlight controls is being used by something called  `rpi_backlight`

```
19 3 "GPIO19" "rpi_backlight"
``````

Sadly I had trouble controlling it. I couldn't get it to work with lgpio nor any command line utility that's one apt-get away.
Modifying the brightness file under /sys/class/backlight/rpi_backlight/brightness also did nothing.

The RPi.GPIO module this uses writes directly to memory, overriding all sanity checks.
