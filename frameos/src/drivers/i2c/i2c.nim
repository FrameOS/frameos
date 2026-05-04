import frameos/device_setup

proc setup*(): SetupResult =
  result = setupBootConfig(@["dtparam=i2c_vc=on"])
  if not commandExists("raspi-config"):
    echo "raspi-config not found; skipped runtime I2C enable"
    return
  if commandSucceeds(privilegedCommand("raspi-config nonint get_i2c") & " | grep -q \"1\""):
    discard runSetupCommand(privilegedCommand("raspi-config nonint do_i2c 0"))
    result.rebootRequired = true
    echo "I2C enabled"
  else:
    echo "I2C already enabled"
