This folder is synced from https://github.com/waveshareteam/e-Paper/blob/master/RaspberryPi_JetsonNano/c/lib/e-Paper/

To update:

1. Copy new C sources (`EPD_*` files) to `frameos/src/drivers/waveshare/ePaper`
   - Rename `EPD_7in5b_V2_old.*` as `EPD_7in5b_V2.*`
   - Rename `EPD_7in5b_V2.*` to `EPD_7in5b_V2_gray.*`
2. Run `cd frameos/src/drivers/waveshare/ePaper && make` to generate new `.nim` files
3. Run `cd backend && python3 list_devices.py` and verify the driver is listed with the right resolution and color
4. If not, you might need to edit the auto-detection routine in `convert_waveshare_source` in `backend/app/drivers/waveshare.py`.
5. If the color remains `Unknown` and the `Display` function takes just one parameter, update the `VARIANT_COLORS` dictionary with the right color. 
6. Finally, copy the output of `list_devices.py` into `frontend/src/devices.ts` 

Local change to reapply after a resync: the ESP32 firmware links every driver
into one binary, so the `LUT_DATA_4Gray` globals in `EPD_13in3k.c`,
`EPD_2in7_V2.c`, `EPD_4in26.c` and `EPD_5in79.c` are marked `static` (they are
file-local anyway; the vendor tree leaves them external and they collide at
link time). No other vendor sources are modified.
