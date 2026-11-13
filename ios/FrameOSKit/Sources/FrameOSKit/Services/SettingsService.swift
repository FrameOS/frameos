import Foundation

/// What the voice chat may do on a frame (docs/voice-chat.md): the owner's
/// four switches, plane-side policy. The cloud keeps them in
/// `voice_permissions`, a backend in device_config (`voiceChangeSettings`, ...).
/// A copy of frontend/src/utils/voiceChat.ts; keys and defaults agree with
/// cloud/apps/auth-web/src/lib/voice-permissions.ts and backend/app/utils/voice_chat.py.
public struct VoicePermissions: Equatable, Sendable {
    public static let keys = ["change_settings", "use_scenes", "create_scenes", "use_albums"]
    static let deviceConfigKeys: [String: (camel: String, snake: String)] = [
        "change_settings": ("voiceChangeSettings", "voice_change_settings"),
        "use_scenes": ("voiceUseScenes", "voice_use_scenes"),
        "create_scenes": ("voiceCreateScenes", "voice_create_scenes"),
        "use_albums": ("voiceUseAlbums", "voice_use_albums"),
    ]
    public static let titles: [String: String] = [
        "change_settings": "Change settings",
        "use_scenes": "Use installed scenes",
        "create_scenes": "Create new scenes",
        "use_albums": "Access photo albums",
    ]

    public var values: [String: Bool]

    public init(values: [String: Bool] = [:]) {
        var all: [String: Bool] = [:]
        for key in Self.keys { all[key] = values[key] ?? true }
        self.values = all
    }

    public static func of(_ frame: Frame, plane: PlaneKind) -> VoicePermissions {
        var values: [String: Bool] = [:]
        switch plane {
        case .cloud:
            for key in keys {
                if case .bool(let value)? = frame["voice_permissions"]?[key] { values[key] = value }
            }
        case .backend:
            let config = frame.deviceConfig
            for key in keys {
                let names = deviceConfigKeys[key]!
                if case .bool(let value)? = config[names.camel].nonNull ?? config[names.snake].nonNull { values[key] = value }
            }
        }
        return VoicePermissions(values: values)
    }
}

/// Whether a frame has a microphone at all (frontend/src/utils/voiceChat.ts):
/// the voice controls are drawn only then.
public enum Microphone {
    static let presetPins: [String: (clk: Int, data: Int)] = [
        "seeed_reterminal_sticky": (19, 20),
        "seeed_reterminal_e1001": (42, 41),
        "seeed_reterminal_e1002": (42, 41),
        "seeed_reterminal_e1003": (42, 41),
    ]
    static let codecPresets: Set<String> = ["waveshare_esp32_s3_photopainter", "waveshare_esp32_s3_epaper_13_3e6"]

    public static func present(_ frame: Frame, plane: PlaneKind) -> Bool {
        switch plane {
        case .cloud:
            let hardware = frame.hardware
            let preset = hardware["hardwarePreset"]?.stringValue ?? ""
            if codecPresets.contains(preset) { return true }
            let board = presetPins[preset]
            let clk = frame["mic_clk_pin"]?.intValue ?? hardware["micClkPin"]?.intValue ?? board?.clk ?? -1
            let data = frame["mic_data_pin"]?.intValue ?? hardware["micDataPin"]?.intValue ?? board?.data ?? -1
            return clk >= 0 && data >= 0
        case .backend:
            guard frame.mode == "embedded" else { return false }
            let config = frame.deviceConfig
            let preset = frame["embedded"]?["hardwarePreset"]?.stringValue ?? config["hardwarePreset"]?.stringValue ?? ""
            if codecPresets.contains(preset) { return true }
            let board = presetPins[preset]
            let clk = (config["micClkPin"].nonNull ?? config["mic_clk_pin"].nonNull)?.intValue ?? board?.clk ?? -1
            let data = (config["micDataPin"].nonNull ?? config["mic_data_pin"].nonNull)?.intValue ?? board?.data ?? -1
            return clk >= 0 && data >= 0
        }
    }
}

/// A schedule entry (`frame.schedule.events`, both planes).
public struct ScheduleEvent: Identifiable, Hashable, Sendable {
    public var raw: [String: JSONValue]
    public init(raw: [String: JSONValue]) { self.raw = raw }

    public static func new(sceneId: String, hour: Int, minute: Int, weekday: Int) -> ScheduleEvent {
        ScheduleEvent(raw: [
            "id": .string(UUID().uuidString.lowercased()), "hour": .number(Double(hour)), "minute": .number(Double(minute)),
            "weekday": .number(Double(weekday)), "event": "setCurrentScene", "payload": ["sceneId": .string(sceneId)],
        ])
    }

    public var id: String { raw["id"]?.stringValue ?? "" }
    public var hour: Int { get { raw["hour"]?.intValue ?? 0 } set { raw["hour"] = .number(Double(newValue)) } }
    public var minute: Int { get { raw["minute"]?.intValue ?? 0 } set { raw["minute"] = .number(Double(newValue)) } }
    /// 0 every day, 1–7 Monday–Sunday, 8 weekdays, 9 weekends.
    public var weekday: Int { get { raw["weekday"]?.intValue ?? 0 } set { raw["weekday"] = .number(Double(newValue)) } }
    public var event: String { raw["event"]?.stringValue ?? "setCurrentScene" }
    public var sceneId: String? { raw["payload"]?["sceneId"]?.stringValue }
    public var disabled: Bool {
        get { raw["disabled"]?.boolValue ?? false }
        // removeValue, not `= nil`: JSONValue takes `nil` as a literal (JSON null).
        set { if newValue { raw["disabled"] = .bool(true) } else { raw.removeValue(forKey: "disabled") } }
    }

    public static let weekdayNames = ["Every day", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
                                      "Sunday", "Weekdays", "Weekends"]
}

/// "Render scenes" as the settings offer it on one frame (the SPA's
/// RenderOnServerChoice, PowerSettingsFields.tsx). The words are the SPA's.
public struct RenderOnServerChoice: Sendable, Equatable {
    public var serverName: String
    /// What the scenes reach once they run there.
    public var reach: String
    /// Why it cannot be chosen yet (firmware too old), or nil.
    public var disabledReason: String?
    /// What choosing it costs, said under it once it is chosen.
    public var note: String?

    public init(serverName: String, reach: String, disabledReason: String? = nil, note: String? = nil) {
        self.serverName = serverName
        self.reach = reach
        self.disabledReason = disabledReason
        self.note = note
    }

    public var remoteLabel: String { "On \(serverName)" }

    public var explanation: String {
        "On the server, \(serverName) runs this frame's scenes and sends it the finished picture. The frame only wakes, "
            + "downloads the picture and refreshes the screen: no scene code, no image decoding and no data fetching on "
            + "the frame, so a battery lasts longer. When nothing changed, the frame skips the download and the refresh. "
            + "A sleeping frame's next picture is drawn just before it wakes. \(reach) The frame changes over at its next render."
    }
}

/// "Processor speed" as the settings offer it (PowerSettingsFields.tsx).
public struct CpuModeChoice: Sendable, Equatable {
    public var disabledReason: String?
    /// What the frame says it runs at now (cloud `hardware.cpuMhz`).
    public var reportedMhz: Int?

    public static let options: [(value: String, label: String)] = [
        ("auto", "Automatic (default)"),
        ("battery", "Battery: 160 MHz"),
        ("performance", "Performance: 240 MHz"),
    ]

    public static let explanation = "Battery runs the chip at 160 MHz, performance at 240 MHz. Performance renders about "
        + "a third faster, but the chip also waits out the screen refresh at the higher speed, about 20 seconds on a "
        + "reTerminal E1002. On a battery e-paper frame that costs roughly 5 to 10% of battery life. Automatic is battery "
        + "on e-paper and performance on LCD and touch screens. Saving a change reboots the frame."

    public static func == (lhs: CpuModeChoice, rhs: CpuModeChoice) -> Bool {
        lhs.disabledReason == rhs.disabledReason && lhs.reportedMhz == rhs.reportedMhz
    }
}

extension FrameOSService {
    /// The settings the app edits for this frame, by wire name. On the cloud
    /// it is what the contract lets this frame's profile and firmware take;
    /// on a backend every one of them (the backend validates the rest).
    public func editableSettings(_ frame: Frame) -> Set<String> {
        let common: Set<String> = ["rotate", "interval", "scaling_mode", "render_scale", "timezone", "frame_settings_on_screen",
                                   "debug", "flip", "deep_sleep", "deep_sleep_on_battery", "wake_check_seconds"]
        switch kind {
        case .cloud:
            return common.intersection(CloudSettingsContract.shared.keys(for: frame))
        case .backend:
            // A backend keeps an ESP32's power settings in device_config
            // (edited in the web workspace), and flip is a Linux setting.
            let keys = common.subtracting(["deep_sleep", "deep_sleep_on_battery", "wake_check_seconds"])
            return frame.isEmbedded ? keys.subtracting(["flip"]) : keys
        }
    }

    /// Save settings and send them to the frame. Cloud: `POST …/settings`
    /// (queued as `set_settings`). Backend: `POST /api/frames/{id}` then a
    /// deploy ("Deploy settings").
    public func saveSettings(_ frame: Frame, _ changes: [String: JSONValue]) async throws -> ActionOutcome {
        var changes = changes
        if kind == .cloud, changes["timezone"] == .string("") {
            // The contract wants a zone (minLen 1): no zone is not a setting.
            changes["timezone"] = nil
        }
        if changes.isEmpty { return ActionOutcome(kind: .done, message: "Nothing changed.") }
        switch kind {
        case .cloud:
            let answer = try await client.call("POST", Self.framePath(frame.id, "/settings"),
                                               body: .json(["settings": .object(changes)]))
            return ActionOutcome.from(answer, queuedMessage: "Saved. The frame takes the settings when it next checks in.")
        case .backend:
            // Where the scenes run and the processor speed live in an
            // ESP32's device_config, which the board reads on its next
            // settings poll (the SPA's setEmbeddedPowerSettings): no deploy
            // for those alone.
            var body = changes
            var config = frame.deviceConfig
            var deviceConfigChanged = false
            for (key, camel) in Self.deviceConfigSettings {
                guard let value = body.removeValue(forKey: key) else { continue }
                // The snake_case twin is what a USB provisioning writes; the
                // device would keep reading a stale copy it checks first.
                config.removeValue(forKey: key)
                config[camel] = value
                deviceConfigChanged = true
            }
            let deploys = !body.isEmpty
            if deviceConfigChanged { body["device_config"] = .object(config) }
            try await client.call("POST", Self.framePath(frame.id), body: .json(.object(body)))
            if !deploys {
                return ActionOutcome(kind: .done, message: "Saved. The frame takes it on its next settings poll.")
            }
            return try await deploy(frame)
        }
    }

    /// Settings the app edits by their cloud name that a backend keeps in an
    /// ESP32's device_config, under the camelCase name.
    static let deviceConfigSettings: [(String, String)] = [("render_mode", "renderMode"), ("cpu_mode", "cpuMode")]

    // MARK: where the scenes run, and the processor speed (Settings, Power)

    /// "Render scenes" for this frame (the SPA's RenderScenesField, offered
    /// where frameSettingsContext.tsx offers it), or nil where it is not:
    /// on the cloud an ESP32 that can render itself (a C3 is rendered by the
    /// cloud anyway), gated on the firmware that takes `render_mode`; on a
    /// backend an embedded ESP32 that is not a thin client.
    public func renderOnServerChoice(_ frame: Frame) -> RenderOnServerChoice? {
        switch kind {
        case .cloud:
            guard CloudSettingsContract.profile(for: frame) == "esp32",
                  RenderOnServer.canRenderItself(hardware: frame.raw["hardware"]?.objectValue)
            else { return nil }
            let contract = CloudSettingsContract.shared
            let supported = contract.keys(for: frame).contains("render_mode")
            let since = contract.since("render_mode", profile: "esp32") ?? ""
            return RenderOnServerChoice(
                serverName: "FrameOS Cloud",
                reach: "Scenes then fetch their data from FrameOS Cloud, which reaches public addresses only, not your network.",
                disabledReason: supported ? nil : "Rendering on the server needs FrameOS \(since) or newer on the frame.",
                note: "Counts as one of your plan's cloud-rendered frames (Settings, Usage), and its refresh interval cannot go below the plan's minimum."
            )
        case .backend:
            guard frame.mode == "embedded", RenderOnServer.backendOffers(platform: embeddedPlatform(frame)) else { return nil }
            return RenderOnServerChoice(
                serverName: "the backend",
                reach: "Scenes then fetch their data from the backend, so they reach what it reaches: your network, a VPN."
            )
        }
    }

    /// Where the frame's scenes run now: the owner's setting, else (cloud)
    /// what the device reports running with.
    public func renderMode(_ frame: Frame) -> RenderMode {
        switch kind {
        case .cloud:
            return RenderOnServer.cloudMode(renderMode: frame["render_mode"], hardware: frame.raw["hardware"]?.objectValue)
        case .backend:
            return RenderOnServer.backendMode(deviceConfig: frame["device_config"], embedded: frame["embedded"])
        }
    }

    /// "Processor speed" for this frame (the SPA's field next to "Render
    /// scenes"), or nil: every cloud ESP32, gated on the firmware that takes
    /// `cpu_mode`; on a backend an embedded board with the ESP32 power
    /// profile.
    public func cpuModeChoice(_ frame: Frame) -> CpuModeChoice? {
        switch kind {
        case .cloud:
            guard CloudSettingsContract.profile(for: frame) == "esp32" else { return nil }
            let contract = CloudSettingsContract.shared
            let since = contract.since("cpu_mode", profile: "esp32") ?? ""
            return CpuModeChoice(
                disabledReason: contract.keys(for: frame).contains("cpu_mode")
                    ? nil : "The processor speed needs FrameOS \(since) or newer on the frame.",
                reportedMhz: frame.hardware["cpuMhz"]?.intValue
            )
        case .backend:
            guard frame.mode == "embedded", RenderOnServer.backendPowerProfile(platform: embeddedPlatform(frame)) == "esp32"
            else { return nil }
            return CpuModeChoice(disabledReason: nil, reportedMhz: nil)
        }
    }

    /// The processor speed the frame is set to (cloud: else what it reports), `auto` by default.
    public func cpuMode(_ frame: Frame) -> String {
        let value: JSONValue?
        switch kind {
        case .cloud: value = frame["cpu_mode"].nonNull ?? frame.hardware["cpuMode"]
        case .backend: value = frame.deviceConfig["cpuMode"].nonNull ?? frame.deviceConfig["cpu_mode"]
        }
        let mode = value?.stringValueIfString ?? "auto"
        return CpuModeChoice.options.contains { $0.value == mode } ? mode : "auto"
    }

    func embeddedPlatform(_ frame: Frame) -> String? {
        frame["embedded"]?["platform"]?.stringValueIfString
    }

    public func schedule(_ frame: Frame) -> (events: [ScheduleEvent], disabled: Bool) {
        let schedule = frame["schedule"]
        let events = (schedule?["events"]?.arrayValue ?? []).compactMap { $0.objectValue }.map(ScheduleEvent.init)
        return (events, schedule?["disabled"]?.boolValue ?? false)
    }

    public func saveSchedule(_ frame: Frame, events: [ScheduleEvent], disabled: Bool) async throws -> ActionOutcome {
        var schedule: [String: JSONValue] = ["events": .array(events.map { .object($0.raw) })]
        if disabled { schedule["disabled"] = true }
        switch kind {
        case .cloud:
            let offset = TimeZone(identifier: frame["timezone"]?.stringValue ?? "")?.secondsFromGMT() ?? TimeZone.current.secondsFromGMT()
            let answer = try await client.call("POST", Self.framePath(frame.id, "/schedule"), body: .json([
                "schedule": .object(schedule), "utcOffsetMinutes": .number(Double(offset / 60)),
            ]))
            return ActionOutcome.from(answer, queuedMessage: "Saved. The frame takes the schedule when it next checks in.")
        case .backend:
            try await client.call("POST", Self.framePath(frame.id), body: .json(["schedule": .object(schedule)]))
            return try await deploy(frame)
        }
    }

    /// The frame's own button map, or nil when it runs its board's preset
    /// (read with ButtonBindings.split).
    public func eventMap(_ frame: Frame) -> [JSONValue]? {
        frame["event_map"]?.arrayValue
    }

    /// How many rules the frame's button map holds: an ESP32 keeps it in a
    /// 1 KB slot (the contract's esp32 rule, maxItems 8), the rest 32.
    public func eventMapLimit(_ frame: Frame) -> Int {
        let contract = CloudSettingsContract.shared
        return contract.maxItems("event_map", profile: CloudSettingsContract.profile(for: frame)) ?? 32
    }

    /// Replace the frame's button map. An empty list is a choice and stays
    /// empty (no buttons do anything frame-wide).
    public func saveEventMap(_ frame: Frame, rules: [JSONValue]) async throws -> ActionOutcome {
        try await saveSettings(frame, ["event_map": .array(rules)])
    }

    public func saveVoicePermissions(_ frame: Frame, _ permissions: VoicePermissions) async throws {
        switch kind {
        case .cloud:
            var body: [String: JSONValue] = [:]
            for (key, value) in permissions.values { body[key] = .bool(value) }
            try await client.call("POST", Self.framePath(frame.id, "/voice/permissions"), body: .json(.object(body)))
        case .backend:
            var config = frame.deviceConfig
            for (key, value) in permissions.values {
                guard let names = VoicePermissions.deviceConfigKeys[key] else { continue }
                config[names.snake] = nil
                config[names.camel] = .bool(value)
            }
            // Plane-side policy: saved on the backend, never deployed.
            try await client.call("POST", Self.framePath(frame.id), body: .json(["device_config": .object(config)]))
        }
    }

    // MARK: account

    /// The account's API keys (masked), by group (`/api/settings`, both planes).
    public func serviceSettings() async throws -> [String: JSONValue] {
        try await client.get("/api/settings").objectValue ?? [:]
    }

    /// Save one group of API keys. A masked value posted back keeps the stored key.
    public func saveServiceSettings(group: String, values: [String: JSONValue]) async throws {
        try await client.call("POST", "/api/settings", body: .json([group: .object(values)]))
    }

    /// Who is signed in, and (cloud) the plan and quotas.
    public func accountSummary() async throws -> JSONValue {
        switch kind {
        case .cloud: return try await client.get("/api/account/usage")
        case .backend: return try await client.get("/api/user")
        }
    }
}

extension FrameOSService {
    /// Whether the cloud account has a password: deleting it asks for that;
    /// one without (Google, passkeys) confirms it is you and types its email.
    public func cloudAccountHasPassword() async throws -> Bool {
        try await client.get("/api/account/security")["has_password"]?.boolValue ?? false
    }

    /// `POST /api/account/delete`: the cloud erases the account with its
    /// frames' links, scenes, photos and keys (a paid plan is cancelled
    /// first). App Store guideline 5.1.1(v): deletion is in the app.
    public func deleteCloudAccount(password: String?, confirmEmail: String) async throws {
        var body: [String: JSONValue] = ["confirmEmail": .string(confirmEmail)]
        if let password, !password.isEmpty { body["password"] = .string(password) }
        try await client.call("POST", "/api/account/delete", body: .json(.object(body)))
    }

    /// `POST /api/store/scenes/{id}/report {reason}`: the store's report
    /// queue (App Store guideline 1.2, content other people made).
    public func reportStoreScene(_ storeSceneId: String, reason: String) async throws {
        try await client.call("POST", "/api/store/scenes/\(ApiPaths.segment(storeSceneId))/report",
                              body: .json(["reason": .string(reason)]))
    }
}
