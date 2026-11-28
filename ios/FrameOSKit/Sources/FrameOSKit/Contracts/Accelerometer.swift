import Foundation

/// Whether a frame has an accelerometer (docs/accelerometer.md): what offers
/// its motion gestures (a flick, a tilt, a shake, laid face down) in Button
/// actions. A port of frontend/src/utils/accelerometer.ts
/// `frameHasAccelerometer`: the board's hardware report (`imu`) when it has
/// sent one, else its preset (the two boards FrameOS knows one on).
public enum Accelerometer {
    public static let hardwarePresets: Set<String> = ["seeed_reterminal_sticky", "waveshare_esp32_s3_touch_amoled_1_75"]

    public static func present(_ frame: Frame) -> Bool {
        if case .bool(let reported)? = frame.hardware["imu"] { return reported }
        let preset = [frame.hardware["hardwarePreset"], frame["embedded"]?["hardwarePreset"],
                      frame.deviceConfig["hardwarePreset"]]
            .compactMap { $0?.stringValueIfString }.first { !$0.isEmpty } ?? ""
        return hardwarePresets.contains(preset)
    }
}
