{
  name = "spi0-0cs-low";
  dtsText = ''
    /dts-v1/;
    /plugin/;

    / {
      compatible = "brcm,bcm2837";    /* Pi Zero 2 W SoC */
      fragment@0 {
        target = <&gpio>;
        __overlay__ {
          cs7: cs7_state {
            brcm,pins     = <7>;
            brcm,function = <1>;      /* output */
            output-low;
          };
          cs8: cs8_state {
            brcm,pins     = <8>;
            brcm,function = <1>;
            output-low;
          };
        };
      };
    };
  '';
}
