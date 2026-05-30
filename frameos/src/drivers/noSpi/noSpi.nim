import frameos/device_setup
import frameos/driver_context

proc setup*(frameOS: DriverContext = nil): SetupResult =
  discard frameOS
  if not commandExists("raspi-config"):
    echo "raspi-config not found; using boot config SPI disable fallback"
    return setupBootConfig(@["#dtparam=spi=on"])

  if commandSucceeds(privilegedCommand("raspi-config nonint get_spi") & " | grep -q \"0\""):
    discard runSetupCommand(privilegedCommand("raspi-config nonint do_spi 1"))
    result.rebootRequired = true
    echo "SPI disabled"
  else:
    echo "SPI already disabled"
