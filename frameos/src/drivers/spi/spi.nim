import frameos/device_setup
import frameos/driver_context

proc setup*(frameOS: DriverContext = nil): SetupResult =
  discard frameOS
  if not commandExists("raspi-config"):
    echo "raspi-config not found; using boot config SPI enable fallback"
    return setupBootConfig(@["dtparam=spi=on"])

  if commandSucceeds(privilegedCommand("raspi-config nonint get_spi") & " | grep -q \"1\""):
    discard runSetupCommand(privilegedCommand("raspi-config nonint do_spi 0"))
    result.rebootRequired = true
    echo "SPI enabled"
  else:
    echo "SPI already enabled"
