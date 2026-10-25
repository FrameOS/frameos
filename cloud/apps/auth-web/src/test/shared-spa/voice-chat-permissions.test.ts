import { describe, expect, it } from "vitest";
import {
  backendFrameHasMicrophone,
  cloudFrameHasMicrophone,
  configuredMicrophone,
  DEFAULT_VOICE_PERMISSIONS,
  deviceConfigWithVoicePermission,
  EMBEDDED_PRESETS_WITH_MICROPHONE,
  VOICE_PERMISSION_KEYS,
  voicePermissionsFromDeviceConfig,
  voicePermissionsOf,
} from "../../../../../../frontend/src/utils/voiceChat";
import {
  defaultVoicePermissions,
  readVoicePermissions,
  voicePermissionKeys,
} from "../../lib/voice-permissions";

// The SPA's half of the voice chat's switches (docs/voice-chat.md "What the
// voice chat may do"): when a frame has a microphone at all (the controls are
// not drawn without one), and the two spellings of the three switches. The
// cloud's reader is pinned to the same keys and defaults.

describe("which frames have a microphone", () => {
  it("reads the configured pins first: both set is one, either -1 is none, otherwise the board's own", () => {
    expect(configuredMicrophone(42, 41)).toBe(true);
    expect(configuredMicrophone(-1, 41)).toBe(false);
    expect(configuredMicrophone(42, -1)).toBe(false);
    expect(configuredMicrophone(undefined, undefined)).toBeNull();
    // One pin alone leaves the other to the board, so the board decides.
    expect(configuredMicrophone(42, undefined)).toBeNull();
  });

  it("on a backend frame falls back to the preset: the E1001 and E1002 have one, the E1004 does not", () => {
    expect([...EMBEDDED_PRESETS_WITH_MICROPHONE]).toEqual(["seeed_reterminal_e1001", "seeed_reterminal_e1002"]);
    expect(backendFrameHasMicrophone({}, "seeed_reterminal_e1001")).toBe(true);
    expect(backendFrameHasMicrophone({}, "seeed_reterminal_e1002")).toBe(true);
    expect(backendFrameHasMicrophone({}, "seeed_reterminal_e1004")).toBe(false);
    expect(backendFrameHasMicrophone(undefined, "custom")).toBe(false);
    // Pins configured on an E1004's J2 header (either spelling) make a microphone.
    expect(backendFrameHasMicrophone({ micClkPin: 42, micDataPin: 41 }, "seeed_reterminal_e1004")).toBe(true);
    expect(backendFrameHasMicrophone({ mic_clk_pin: 42, mic_data_pin: 41 }, "seeed_reterminal_e1004")).toBe(true);
    // And -1 on an E1001 switches its own off.
    expect(backendFrameHasMicrophone({ micClkPin: -1 }, "seeed_reterminal_e1001")).toBe(false);
  });

  it("on a cloud frame believes the form's pins, then the hello's hardware.microphone", () => {
    expect(cloudFrameHasMicrophone({ platform: "esp32-s3", microphone: true }, {})).toBe(true);
    expect(cloudFrameHasMicrophone({ platform: "esp32-s3", microphone: false }, {})).toBe(false);
    // Older firmware reports nothing: no controls until it does, or pins are set.
    expect(cloudFrameHasMicrophone({ platform: "esp32-s3" }, {})).toBe(false);
    expect(cloudFrameHasMicrophone(null, {})).toBe(false);
    expect(cloudFrameHasMicrophone({ platform: "esp32-s3" }, { mic_clk_pin: 42, mic_data_pin: 41 })).toBe(true);
    expect(cloudFrameHasMicrophone({ platform: "esp32-s3", microphone: true }, { mic_clk_pin: -1 })).toBe(false);
  });
});

describe("the three switches", () => {
  it("default to settings and installed scenes on, new scenes off, on both planes", () => {
    expect(DEFAULT_VOICE_PERMISSIONS).toEqual({ change_settings: true, use_scenes: true, create_scenes: false });
    expect(defaultVoicePermissions).toEqual(DEFAULT_VOICE_PERMISSIONS);
    expect([...VOICE_PERMISSION_KEYS]).toEqual([...voicePermissionKeys]);
  });

  it("read the cloud's object with the defaults for what is missing", () => {
    expect(voicePermissionsOf(undefined)).toEqual(DEFAULT_VOICE_PERMISSIONS);
    expect(voicePermissionsOf({ create_scenes: true })).toEqual({ change_settings: true, use_scenes: true, create_scenes: true });
    expect(voicePermissionsOf({ use_scenes: "no" })).toEqual(DEFAULT_VOICE_PERMISSIONS);
    expect(readVoicePermissions({ create_scenes: true })).toEqual(voicePermissionsOf({ create_scenes: true }));
  });

  it("read the backend's device_config in either spelling, camelCase first", () => {
    expect(voicePermissionsFromDeviceConfig(undefined)).toEqual(DEFAULT_VOICE_PERMISSIONS);
    expect(voicePermissionsFromDeviceConfig({ voiceUseScenes: false, voice_create_scenes: true })).toEqual({
      change_settings: true,
      use_scenes: false,
      create_scenes: true,
    });
    expect(voicePermissionsFromDeviceConfig({ voiceUseScenes: true, voice_use_scenes: false }).use_scenes).toBe(true);
  });

  it("write the camelCase key and drop the snake_case twin", () => {
    const next = deviceConfigWithVoicePermission({ voice_create_scenes: false, buzzerPin: 45 }, "create_scenes", true);
    expect(next).toEqual({ buzzerPin: 45, voiceCreateScenes: true });
    expect(deviceConfigWithVoicePermission(undefined, "use_scenes", false)).toEqual({ voiceUseScenes: false });
  });
});
