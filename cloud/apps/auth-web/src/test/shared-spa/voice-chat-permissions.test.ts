import { describe, expect, it } from "vitest";
import {
  backendFrameHasMicrophone,
  boardMicrophonePins,
  cloudFrameHasMicrophone,
  DEFAULT_VOICE_PERMISSIONS,
  effectiveMicrophonePins,
  microphonePinPlaceholder,
  microphonePinsNameOne,
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
  it("knows the board's own pins: the reported ones, else the preset's, else -1", () => {
    expect(boardMicrophonePins({ hardwarePreset: "seeed_reterminal_e1002" })).toEqual({ clk: 42, data: 41, pwr: 38 });
    expect(boardMicrophonePins({ hardwarePreset: "seeed_reterminal_e1004" })).toEqual({ clk: -1, data: -1, pwr: -1 });
    expect(boardMicrophonePins({ hardwarePreset: "custom" })).toEqual({ clk: -1, data: -1, pwr: -1 });
    expect(boardMicrophonePins({})).toEqual({ clk: -1, data: -1, pwr: -1 });
    // A reported pin wins over the preset's table, a reported -1 included.
    expect(boardMicrophonePins({ hardwarePreset: "seeed_reterminal_e1002", reported: { clk: -1 } })).toEqual({
      clk: -1,
      data: 41,
      pwr: 38,
    });
    expect(boardMicrophonePins({ hardwarePreset: "seeed_reterminal_e1004", reported: { clk: 42, data: 41, pwr: null } })).toEqual({
      clk: 42,
      data: 41,
      pwr: -1,
    });
  });

  it("runs with the configured pins over the board's own, and has a microphone when clock and data are GPIOs", () => {
    const board = { clk: 42, data: 41, pwr: 38 };
    expect(effectiveMicrophonePins({}, board)).toEqual(board);
    expect(effectiveMicrophonePins({ clk: -1 }, board)).toEqual({ clk: -1, data: 41, pwr: 38 });
    expect(microphonePinsNameOne(board)).toBe(true);
    expect(microphonePinsNameOne({ clk: -1, data: 41, pwr: 38 })).toBe(false);
    expect(microphonePinsNameOne({ clk: 42, data: -1, pwr: -1 })).toBe(false);
    // Power -1 is "always powered", not "no microphone".
    expect(microphonePinsNameOne({ clk: 42, data: 41, pwr: -1 })).toBe(true);
  });

  it("spells out what an empty pin field means", () => {
    expect(microphonePinPlaceholder(42)).toBe("42 (board default)");
    expect(microphonePinPlaceholder(0)).toBe("0 (board default)");
    expect(microphonePinPlaceholder(-1)).toBe("-1");
  });

  it("on a backend frame falls back to the preset: the Sticky, the E1001, E1002 and E1003 have one, the E1004 does not", () => {
    expect([...EMBEDDED_PRESETS_WITH_MICROPHONE]).toEqual([
      "seeed_reterminal_sticky",
      "seeed_reterminal_e1001",
      "seeed_reterminal_e1002",
      "seeed_reterminal_e1003",
      "waveshare_esp32_s3_photopainter",
      "waveshare_esp32_s3_epaper_13_3e6",
    ]);
    expect(boardMicrophonePins({ hardwarePreset: "seeed_reterminal_sticky" })).toEqual({ clk: 19, data: 20, pwr: 38 });
    expect(backendFrameHasMicrophone({}, "seeed_reterminal_sticky")).toBe(true);
    expect(backendFrameHasMicrophone({}, "seeed_reterminal_e1001")).toBe(true);
    expect(backendFrameHasMicrophone({}, "seeed_reterminal_e1002")).toBe(true);
    expect(backendFrameHasMicrophone({}, "seeed_reterminal_e1003")).toBe(true);
    expect(backendFrameHasMicrophone({}, "seeed_reterminal_e1004")).toBe(false);
    // The Waveshare boards' microphone is their codec's: no PDM pins to
    // show, and -1 pins do not switch it off.
    expect(boardMicrophonePins({ hardwarePreset: "waveshare_esp32_s3_photopainter" })).toEqual({ clk: -1, data: -1, pwr: -1 });
    expect(backendFrameHasMicrophone({}, "waveshare_esp32_s3_photopainter")).toBe(true);
    expect(backendFrameHasMicrophone({ micClkPin: -1 }, "waveshare_esp32_s3_epaper_13_3e6")).toBe(true);
    expect(cloudFrameHasMicrophone({ platform: "esp32-s3", hardwarePreset: "waveshare_esp32_s3_photopainter" }, {})).toBe(true);
    expect(backendFrameHasMicrophone(undefined, "custom")).toBe(false);
    // Pins configured on an E1004's J2 header (either spelling) make a microphone.
    expect(backendFrameHasMicrophone({ micClkPin: 42, micDataPin: 41 }, "seeed_reterminal_e1004")).toBe(true);
    expect(backendFrameHasMicrophone({ mic_clk_pin: 42, mic_data_pin: 41 }, "seeed_reterminal_e1004")).toBe(true);
    // And -1 on an E1001 switches its own off; a device_config with no mic
    // keys at all, or with other keys only, changes nothing on an E1004.
    expect(backendFrameHasMicrophone({ micClkPin: -1 }, "seeed_reterminal_e1001")).toBe(false);
    expect(backendFrameHasMicrophone({ hardwarePreset: "seeed_reterminal_e1004", voiceChat: true }, "seeed_reterminal_e1004")).toBe(false);
    expect(backendFrameHasMicrophone({}, undefined)).toBe(false);
  });

  it("on a cloud frame believes the form's pins, then the reported ones, then the reported preset's", () => {
    expect(cloudFrameHasMicrophone({ platform: "esp32-s3", micClkPin: 42, micDataPin: 41, micPwrPin: 38 }, {})).toBe(true);
    expect(cloudFrameHasMicrophone({ platform: "esp32-s3", micClkPin: -1, micDataPin: -1, micPwrPin: -1 }, {})).toBe(false);
    // Older firmware reports no pins: the preset it reports decides.
    expect(cloudFrameHasMicrophone({ platform: "esp32-s3", hardwarePreset: "seeed_reterminal_e1002" }, {})).toBe(true);
    expect(cloudFrameHasMicrophone({ platform: "esp32-s3", hardwarePreset: "seeed_reterminal_e1004" }, {})).toBe(false);
    expect(cloudFrameHasMicrophone({ platform: "esp32-s3" }, {})).toBe(false);
    expect(cloudFrameHasMicrophone(null, {})).toBe(false);
    // The form's pins (a push on its way) win over everything reported.
    expect(cloudFrameHasMicrophone({ platform: "esp32-s3" }, { mic_clk_pin: 42, mic_data_pin: 41 })).toBe(true);
    expect(cloudFrameHasMicrophone({ platform: "esp32-s3", micClkPin: 42, micDataPin: 41 }, { mic_clk_pin: -1 })).toBe(false);
    // `hardware.microphone` alone is a report of the pins' effect, not the rule's input.
    expect(cloudFrameHasMicrophone({ platform: "esp32-s3", microphone: true }, {})).toBe(false);
  });
});

describe("the three switches", () => {
  it("default to settings, installed scenes and albums on, new scenes off, on both planes", () => {
    expect(DEFAULT_VOICE_PERMISSIONS).toEqual({
      change_settings: true,
      use_scenes: true,
      create_scenes: false,
      use_albums: true,
    });
    expect(defaultVoicePermissions).toEqual(DEFAULT_VOICE_PERMISSIONS);
    expect([...VOICE_PERMISSION_KEYS]).toEqual([...voicePermissionKeys]);
  });

  it("read the cloud's object with the defaults for what is missing", () => {
    expect(voicePermissionsOf(undefined)).toEqual(DEFAULT_VOICE_PERMISSIONS);
    expect(voicePermissionsOf({ create_scenes: true })).toEqual({
      change_settings: true,
      use_scenes: true,
      create_scenes: true,
      use_albums: true,
    });
    expect(voicePermissionsOf({ use_scenes: "no" })).toEqual(DEFAULT_VOICE_PERMISSIONS);
    expect(readVoicePermissions({ create_scenes: true })).toEqual(voicePermissionsOf({ create_scenes: true }));
  });

  it("read the backend's device_config in either spelling, camelCase first", () => {
    expect(voicePermissionsFromDeviceConfig(undefined)).toEqual(DEFAULT_VOICE_PERMISSIONS);
    expect(voicePermissionsFromDeviceConfig({ voiceUseScenes: false, voice_create_scenes: true })).toEqual({
      change_settings: true,
      use_scenes: false,
      create_scenes: true,
      use_albums: true,
    });
    expect(voicePermissionsFromDeviceConfig({ voice_use_albums: false }).use_albums).toBe(false);
    expect(voicePermissionsFromDeviceConfig({ voiceUseScenes: true, voice_use_scenes: false }).use_scenes).toBe(true);
  });

  it("write the camelCase key and drop the snake_case twin", () => {
    const next = deviceConfigWithVoicePermission({ voice_create_scenes: false, buzzerPin: 45 }, "create_scenes", true);
    expect(next).toEqual({ buzzerPin: 45, voiceCreateScenes: true });
    expect(deviceConfigWithVoicePermission(undefined, "use_scenes", false)).toEqual({ voiceUseScenes: false });
    expect(deviceConfigWithVoicePermission(undefined, "use_albums", false)).toEqual({ voiceUseAlbums: false });
  });
});
