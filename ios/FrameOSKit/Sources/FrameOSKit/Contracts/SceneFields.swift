import Foundation

/// A scene's state field (the SPA's `StateField`, frontend/src/types.tsx):
/// what the scene settings form draws for a public field.
public struct SceneField: Identifiable, Hashable, Sendable {
    public var raw: [String: JSONValue]

    public init(raw: [String: JSONValue]) { self.raw = raw }

    public var id: String { name }
    public var name: String { raw["name"]?.stringValue ?? "" }
    public var label: String {
        let label = raw["label"]?.stringValue ?? ""
        return label.isEmpty ? name : label
    }
    public var type: String { raw["type"]?.stringValue ?? "string" }
    public var access: String { raw["access"]?.stringValue ?? "private" }
    public var role: String? { raw["role"]?.stringValue }
    public var defaultValue: JSONValue? { raw["value"] }
    public var placeholder: String? { raw["placeholder"]?.stringValue }
    public var hint: String? { raw["hint"]?.stringValue }
    public var secret: Bool { raw["secret"]?.boolValue ?? false }
    public var required: Bool { raw["required"]?.boolValue ?? false }
    public var rows: Int? { raw["rows"]?.intValue }
    public var showIf: [JSONValue] { raw["showIf"]?.arrayValue ?? [] }

    /// A select's options: plain strings, or `{value, label}`.
    public var options: [(value: String, label: String)] {
        (raw["options"]?.arrayValue ?? []).compactMap { option in
            if let text = option.stringValueIfString { return (text, text) }
            if let value = option["value"]?.stringValue {
                return (value, option["label"]?.stringValue ?? value)
            }
            return nil
        }
    }
}

/// The scene settings form's rules, ported from the SPA and pinned to it by
/// docs/scene-form-fixtures.json (replayed by
/// cloud/apps/auth-web/src/test/shared-spa/scene-form-fixtures.test.ts and
/// SceneFormFixtureTests): `sceneStateFields` (frontend/src/utils/refreshInterval.ts:
/// the implicit "Refresh interval (seconds)" field) and
/// `visiblePublicStateFields` / `coerceStateFieldValue` (utils/showIf.ts).
public enum SceneForm {
    public static let refreshIntervalRole = "refreshInterval"
    public static let refreshIntervalName = "refreshInterval"
    public static let refreshIntervalLabel = "Refresh interval (seconds)"
    public static let defaultRefreshSeconds: Double = 300

    static func parseRefreshSeconds(_ value: JSONValue?) -> Double {
        guard let value else { return 0 }
        switch value {
        case .number(let number): return number.isFinite && number > 0 ? number : 0
        case .string(let text):
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty { return 0 }
            guard let number = Double(trimmed), number.isFinite, number > 0 else { return 0 }
            return number
        default: return 0
        }
    }

    static func formatSeconds(_ seconds: Double) -> String {
        seconds.rounded() == seconds && abs(seconds) < 1e15 ? String(Int64(seconds)) : String(seconds)
    }

    /// Every state field of the scene in its own order, plus the implicit
    /// refresh interval last when it declares none.
    public static func stateFields(_ scene: JSONValue?) -> [SceneField] {
        let fields = (scene?["fields"]?.arrayValue ?? []).compactMap { $0.objectValue }.map(SceneField.init)
        let settingsDefault = parseRefreshSeconds(scene?["settings"]?["refreshInterval"]).nonZero ?? defaultRefreshSeconds
        let isNumeric: (SceneField) -> Bool = { $0.type == "float" || $0.type == "integer" }
        var index = fields.firstIndex { $0.role == refreshIntervalRole }
        if index == nil {
            index = fields.firstIndex { $0.name == refreshIntervalName && isNumeric($0) }
        }
        if let index {
            return fields.enumerated().map { offset, field in
                guard offset == index else { return field }
                var stamped = field
                stamped.raw["role"] = .string(refreshIntervalRole)
                return stamped
            }
        }
        if fields.contains(where: { $0.name == refreshIntervalName }) {
            return fields
        }
        return fields + [SceneField(raw: [
            "name": .string(refreshIntervalName),
            "label": .string(refreshIntervalLabel),
            "type": "float",
            "value": .string(formatSeconds(settingsDefault)),
            "persist": "disk",
            "access": "public",
            "role": .string(refreshIntervalRole),
        ])]
    }

    /// A raw form value coerced to the field's type, so `showIf` compares
    /// like the SPA and the frame do. nil: no value (the SPA's undefined).
    public static func coerce(_ field: SceneField, _ value: JSONValue?) -> JSONValue? {
        guard let value, !value.isNull else { return value }
        switch field.type {
        case "boolean":
            return .bool(value == .bool(true) || value == .string("true"))
        case "integer":
            if case .number(let number) = value { return .number(number.rounded(.towardZero)) }
            guard let parsed = jsParseInt(value.stringValue ?? "") else { return nil }
            return .number(parsed)
        case "float":
            if case .number = value { return value }
            guard let parsed = jsParseFloat(value.stringValue ?? "") else { return nil }
            return .number(parsed)
        default:
            return value
        }
    }

    /// Field defaults overlaid with the given value maps, coerced.
    public static func showIfValues(_ fields: [SceneField], _ sources: [[String: JSONValue]]) -> [String: JSONValue] {
        var values: [String: JSONValue] = [:]
        for field in fields where !field.name.isEmpty {
            var value = field.defaultValue
            for source in sources {
                if let candidate = source[field.name] { value = candidate }
            }
            if let coerced = coerce(field, value) { values[field.name] = coerced }
        }
        return values
    }

    /// The public fields to draw, given the current values (later maps win).
    public static func visiblePublicFields(_ fields: [SceneField], _ sources: [[String: JSONValue]]) -> [SceneField] {
        let publicFields = fields.filter { $0.access == "public" }
        let values = showIfValues(publicFields, sources)
        return publicFields.filter { evaluateShowIf($0.showIf, values, currentField: $0.name) }
    }

    public static func evaluateShowIf(_ conditions: [JSONValue], _ values: [String: JSONValue], currentField: String?) -> Bool {
        if conditions.isEmpty { return true }
        return conditions.contains { matches($0, values, currentField) }
    }

    static func matches(_ condition: JSONValue, _ values: [String: JSONValue], _ currentField: String?) -> Bool {
        if let all = condition["and"]?.arrayValue {
            return all.allSatisfy { matches($0, values, currentField) }
        }
        let fieldName = condition["field"]?.stringValue
        let field = (fieldName?.isEmpty == false ? fieldName : nil) ?? currentField ?? ""
        let actual = values[field]
        let expected = condition["value"]
        let hasValue = condition.objectValue?.keys.contains("value") ?? false
        switch condition["operator"]?.stringValue {
        case "eq": return jsEqual(actual, expected)
        case "ne": return !jsEqual(actual, expected)
        case "gt": return jsCompare(actual, expected) { $0 > $1 }
        case "lt": return jsCompare(actual, expected) { $0 < $1 }
        case "gte": return jsCompare(actual, expected) { $0 >= $1 }
        case "lte": return jsCompare(actual, expected) { $0 <= $1 }
        case "in": return expected?.arrayValue?.contains { jsEqual(actual, $0) } ?? false
        case "notIn": return !(expected?.arrayValue?.contains { jsEqual(actual, $0) } ?? false)
        case "empty": return !truthy(actual)
        case "notEmpty": return truthy(actual)
        default:
            if hasValue, let expected { return jsEqual(expected, actual) }
            return truthy(actual)
        }
    }

    /// JavaScript's `===` on JSON values (absent equals only absent).
    static func jsEqual(_ left: JSONValue?, _ right: JSONValue?) -> Bool {
        switch (left, right) {
        case (nil, nil): return true
        case (nil, _), (_, nil): return false
        case (.some(let a), .some(let b)):
            switch (a, b) {
            case (.null, .null): return true
            case (.bool(let x), .bool(let y)): return x == y
            case (.number(let x), .number(let y)): return x == y
            case (.string(let x), .string(let y)): return x == y
            default: return false // objects and arrays compare by identity in JS
            }
        }
    }

    /// `>` and friends: numbers compare as numbers, strings as strings, a
    /// number and a numeric string as numbers; anything else is false.
    static func jsCompare(_ left: JSONValue?, _ right: JSONValue?, _ op: (Double, Double) -> Bool) -> Bool {
        guard let left, let right else { return false }
        if case .string(let a) = left, case .string(let b) = right {
            if a == b { return op(0, 0) }
            return op(a < b ? -1 : 1, 0)
        }
        guard let a = jsNumber(left), let b = jsNumber(right) else { return false }
        return op(a, b)
    }

    static func jsNumber(_ value: JSONValue) -> Double? {
        switch value {
        case .number(let number): return number
        case .bool(let flag): return flag ? 1 : 0
        case .null: return 0
        case .string(let text):
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty { return 0 }
            return Double(trimmed)
        default: return nil
        }
    }

    static func truthy(_ value: JSONValue?) -> Bool {
        guard let value else { return false }
        switch value {
        case .null: return false
        case .bool(let flag): return flag
        case .number(let number): return number != 0 && !number.isNaN
        case .string(let text): return !text.isEmpty
        default: return true
        }
    }

    /// `parseInt(text)`: leading whitespace, a sign, then digits; nil when none.
    static func jsParseInt(_ text: String) -> Double? {
        let trimmed = text.drop { $0.isWhitespace }
        var digits = ""
        var sign: Double = 1
        var rest = Substring(trimmed)
        if rest.first == "-" || rest.first == "+" {
            if rest.first == "-" { sign = -1 }
            rest = rest.dropFirst()
        }
        for character in rest {
            guard character.isASCIIDigitCharacter else { break }
            digits.append(character)
        }
        guard !digits.isEmpty, let value = Double(digits) else { return nil }
        return sign * value
    }

    /// `parseFloat(text)`: the longest leading decimal number; nil when none.
    static func jsParseFloat(_ text: String) -> Double? {
        let trimmed = String(text.drop { $0.isWhitespace })
        guard let range = trimmed.range(of: #"^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?"#, options: .regularExpression) else {
            if trimmed.hasPrefix("Infinity") || trimmed.hasPrefix("+Infinity") { return .infinity }
            if trimmed.hasPrefix("-Infinity") { return -.infinity }
            return nil
        }
        return Double(trimmed[range])
    }

    /// The `state` an Apply sends (the SPA's expandedSceneLogic submit):
    /// booleans as booleans, integers and floats as numbers, the rest as typed.
    public static func applyState(_ fields: [SceneField], values: [String: JSONValue]) -> [String: JSONValue] {
        var state: [String: JSONValue] = [:]
        for field in fields {
            guard let value = values[field.name] else { continue }
            switch field.type {
            case "boolean":
                state[field.name] = .bool(value.boolValue ?? false)
            case "integer":
                if let parsed = (value.numberValueIfNumber.map { $0.rounded(.towardZero) }) ?? jsParseInt(value.stringValue ?? "") {
                    state[field.name] = .number(parsed)
                }
            case "float":
                if let parsed = value.numberValueIfNumber ?? jsParseFloat(value.stringValue ?? "") {
                    state[field.name] = .number(parsed)
                }
            default:
                state[field.name] = value
            }
        }
        return state
    }
}

private extension Double {
    var nonZero: Double? { self == 0 ? nil : self }
}
