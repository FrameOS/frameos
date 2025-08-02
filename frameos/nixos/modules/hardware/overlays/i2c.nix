{
  name = "i2c_arm";
  dtsText = ''
    /dts-v1/;
    /plugin/;
    / { compatible = "brcm,bcm2835";
      fragment@0 { target = <&i2c1>;
        __overlay__ { status = "okay"; };
      };
    };
  '';
}
