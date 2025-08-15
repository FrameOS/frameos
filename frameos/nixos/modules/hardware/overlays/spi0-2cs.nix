{
  name = "spi0-2cs";
  dtsText = ''
    /dts-v1/;
    /plugin/;
    / { compatible = "brcm,bcm2837";
      fragment@0 { target = <&spi0>;
        __overlay__ {
          status = "okay";
          spidev0: spidev@0 {
            compatible        = "spidev";
            reg               = <0>;          // CS0
            spi-max-frequency = <50000000>;
          };
          spidev1: spidev@1 {
            compatible        = "spidev";
            reg               = <1>;          // CS1
            spi-max-frequency = <50000000>;
          };
        };
      };
    };
  '';
}
