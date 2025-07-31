{
  # Two‑channel PWM on GPIO 18/19
  name = "pwm-2chan";
  dtsText = ''
    /dts-v1/;
    /plugin/;
    / { compatible = "brcm,bcm2837";
      fragment@0 { target = <&gpio>;
        __overlay__ {
          pwm_pins: pwm_pins {
            brcm,pins     = <18 19>;
            brcm,function = <2 2>; /* Alt5 */
          };
        };
      };
      fragment@1 { target = <&pwm>;
        __overlay__ {
          pinctrl-names = "default";
          pinctrl-0     = <&pwm_pins>;
          status        = "okay";
        };
      };
    };
  '';
}
