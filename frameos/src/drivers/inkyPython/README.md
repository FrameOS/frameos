Python fallback for Pimoroni Inky devices that still need EEPROM auto-detection
or an unported panel protocol.

Most explicit Pimoroni Inky pHAT, wHAT, and Inky Impression devices now use the
native Nim driver in `../inky`. This fallback remains available for
`pimoroni.inky_impression` and `pimoroni.inky_python`.

The vendored requirements are pinned to Pimoroni `inky==2.4.0`, which includes
Spectra 6 4.0" support and the AC Waveform Spectra 6 EEPROM variants.
