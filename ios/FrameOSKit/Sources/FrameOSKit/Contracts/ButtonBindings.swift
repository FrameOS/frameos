import Foundation

/// The frame's "Button actions" (docs/events.md "Event map"): the rows the
/// section shows — one press of one button, or one swipe in from an edge,
/// and its action — read from and written to the frame's `event_map` rules.
/// A port of frontend/src/utils/frameEventMap.ts (bindingRule,
/// bindingOfRule, the titles), pinned to it by docs/button-map-fixtures.json.
/// Rules the section did not write are kept as they are.
public struct ButtonBinding: Hashable, Sendable, Identifiable {
    public enum Gesture: Hashable, Sendable {
        /// A press of a button: its label and `press` / `doublePress` / `longPress`.
        case button(label: String, action: String)
        /// A swipe in from an edge of a touch screen: left, right, top, bottom.
        case edge(String)
    }

    public var gesture: Gesture
    /// nextScene, prevScene, back, forward, showScene, sceneSwitcher,
    /// sceneSettings, render, turnOn, turnOff, toggleScreen, voiceChat.
    public var kind: String
    /// For `showScene` alone.
    public var sceneId: String?

    public let id = UUID()

    public init(gesture: Gesture, kind: String, sceneId: String? = nil) {
        self.gesture = gesture
        self.kind = kind
        self.sceneId = sceneId
    }

    public static func == (lhs: ButtonBinding, rhs: ButtonBinding) -> Bool {
        lhs.gesture == rhs.gesture && lhs.kind == rhs.kind && lhs.sceneId == rhs.sceneId
    }

    public func hash(into hasher: inout Hasher) {
        hasher.combine(gesture)
        hasher.combine(kind)
        hasher.combine(sceneId)
    }
}

public enum ButtonBindings {
    public static let actionTitles: [String: String] = [
        "nextScene": "Next scene", "prevScene": "Previous scene", "back": "Back", "forward": "Forward",
        "showScene": "Show scene", "sceneSwitcher": "Scene switcher", "sceneSettings": "Scene settings",
        "render": "Refresh", "turnOn": "Display on", "turnOff": "Display off", "toggleScreen": "Display on/off",
        "voiceChat": "Voice chat",
    ]

    /// The scene-less actions offered (voice chat only where there is a microphone).
    public static let actionKinds = ["nextScene", "prevScene", "back", "forward", "sceneSwitcher", "sceneSettings",
                                     "render", "turnOn", "turnOff", "toggleScreen"]

    static let sceneLessEmits: Set<String> = ["back", "forward", "sceneSwitcher", "sceneSettings", "render", "turnOn",
                                              "turnOff", "toggleScreen", "voiceChat"]

    /// The contract's `screenEdges` (docs/events-contract.json).
    public static let screenEdges = ["left", "right", "top", "bottom"]

    static let pressTitles = ["press": "press", "doublePress": "double press", "longPress": "long press"]
    static let edgeTitles = ["left": "Swipe in from the left", "right": "Swipe in from the right",
                             "top": "Swipe down from the top", "bottom": "Swipe up from the bottom"]

    public static func gestureTitle(_ gesture: ButtonBinding.Gesture) -> String {
        switch gesture {
        case .button(let label, let action): return "\(label) · \(pressTitles[action] ?? action)"
        case .edge(let edge): return edgeTitles[edge] ?? "Swipe from \(edge)"
        }
    }

    public static func actionTitle(_ binding: ButtonBinding, sceneName: (String) -> String? = { _ in nil }) -> String {
        guard binding.kind == "showScene" else { return actionTitles[binding.kind] ?? binding.kind }
        let id = binding.sceneId ?? ""
        return "Show scene: \(sceneName(id) ?? (id.isEmpty ? "?" : id))"
    }

    /// The rule the section writes for one binding (the SPA's bindingRule).
    public static func rule(_ binding: ButtonBinding) -> JSONValue {
        let event: JSONValue
        let match: JSONValue
        switch binding.gesture {
        case .button(let label, let action):
            event = "button"
            match = ["label": .string(label), "action": .string(action)]
        case .edge(let edge):
            event = "edgeSwipe"
            match = ["edge": .string(edge)]
        }
        switch binding.kind {
        case "nextScene":
            return ["event": event, "match": match, "emit": "setCurrentScene", "as": ["direction": "next"]]
        case "prevScene":
            return ["event": event, "match": match, "emit": "setCurrentScene", "as": ["direction": "prev"]]
        case "showScene":
            return ["event": event, "match": match, "emit": "setCurrentScene", "as": ["sceneId": .string(binding.sceneId ?? "")]]
        default:
            return ["event": event, "match": match, "emit": .string(binding.kind), "as": [:]]
        }
    }

    /// The binding a rule means, when it is one the section writes (the SPA's bindingOfRule).
    public static func binding(of rule: JSONValue) -> ButtonBinding? {
        let match = rule["match"]?.objectValue ?? [:]
        let gesture: ButtonBinding.Gesture
        if rule["event"]?.stringValueIfString == "button", let label = match["label"]?.stringValueIfString,
           let action = match["action"]?.stringValueIfString, match.count == 2
        {
            gesture = .button(label: label, action: action)
        } else if rule["event"]?.stringValueIfString == "edgeSwipe", let edge = match["edge"]?.stringValueIfString,
                  screenEdges.contains(edge), match.count == 1
        {
            gesture = .edge(edge)
        } else {
            return nil
        }
        guard let emit = rule["emit"]?.stringValueIfString, !emit.isEmpty else { return nil }
        let asValues = rule["as"]?.objectValue ?? [:]
        if emit == "setCurrentScene" {
            if asValues.count == 1, let direction = asValues["direction"]?.stringValueIfString, direction == "next" || direction == "prev" {
                return ButtonBinding(gesture: gesture, kind: direction == "next" ? "nextScene" : "prevScene")
            }
            if asValues.count == 1, let sceneId = asValues["sceneId"]?.stringValueIfString, !sceneId.isEmpty {
                return ButtonBinding(gesture: gesture, kind: "showScene", sceneId: sceneId)
            }
            return nil
        }
        if sceneLessEmits.contains(emit) && asValues.isEmpty {
            return ButtonBinding(gesture: gesture, kind: emit)
        }
        return nil
    }

    /// The section's rows, and every rule it keeps as it is (the SPA's frameBindings).
    public static func split(_ rules: [JSONValue]) -> (bindings: [ButtonBinding], others: [JSONValue]) {
        var bindings: [ButtonBinding] = []
        var others: [JSONValue] = []
        for rule in rules {
            if let binding = binding(of: rule) { bindings.append(binding) } else { others.append(rule) }
        }
        return (bindings, others)
    }

    /// The rows first, then the rules kept as they were (the SPA's frameEventMapRules).
    public static func rules(_ bindings: [ButtonBinding], others: [JSONValue]) -> [JSONValue] {
        bindings.map(rule) + others
    }

    /// A human line for a rule the section did not write.
    public static func describe(_ rule: JSONValue) -> String {
        let match = (rule["match"]?.objectValue ?? [:]).sorted { $0.key < $1.key }
            .map { "\($0.key) \($0.value.stringValue ?? $0.value.jsonString())" }.joined(separator: ", ")
        let event = rule["event"]?.stringValue ?? "?"
        let trigger = match.isEmpty ? event : "\(event) (\(match))"
        if let emit = rule["emit"]?.stringValue { return "\(trigger) → \(emit)" }
        return "\(trigger) → rewritten"
    }
}
