import FrameOSKit
import SwiftUI

/// A scene on a frame: its public fields as a form, and Activate / Apply
/// (the SPA's ExpandedScene drawer, without the diagram).
struct SceneSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let frameId: String
    let scene: InstalledScene
    let model: FrameDetailModel
    @State private var values: [String: JSONValue] = [:]
    @State private var confirmRemove = false

    var active: Bool { model.isActive(scene) }

    var visibleFields: [SceneField] {
        SceneForm.visiblePublicFields(scene.fields, [model.values(for: scene), values])
    }

    var body: some View {
        NavigationStack {
            Form {
                if let frame = app.frame(frameId) {
                    Section {
                        let service = app.service
                        RemoteImage(key: "scene-large:\(frameId):\(scene.id):\(app.imageVersions[frameId] ?? 0)",
                                    load: {
                                        guard let service else { throw CancellationError() }
                                        return try await service.sceneImage(frame, sceneId: scene.id, thumb: false)
                                    },
                                    placeholder: { Rectangle().fill(.quaternary).aspectRatio(frame.aspectRatio, contentMode: .fit) })
                            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                            .listRowInsets(EdgeInsets(top: 8, leading: 8, bottom: 8, trailing: 8))
                    }
                }

                if !scene.hasNodes && scene.storeSceneId != nil {
                    Section {
                        Label("The store could not hand out this scene's content, so its settings cannot be shown.",
                              systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.orange)
                    }
                }

                if !visibleFields.isEmpty {
                    Section {
                        ForEach(visibleFields) { field in
                            SceneFieldEditor(field: field, value: binding(for: field))
                        }
                    } header: {
                        Text("Settings")
                    } footer: {
                        Text(active ? "Apply sends these values to the frame and renders." : "Activate shows the scene with these values.")
                    }
                }

                Section {
                    AsyncButton {
                        await model.activate(app, scene, state: SceneForm.applyState(visibleFields, values: changedValues))
                        values = [:]
                        dismiss()
                    } label: {
                        Label(active ? "Apply" : "Activate", systemImage: active ? "checkmark.circle" : "play.circle")
                            .frame(maxWidth: .infinity)
                            .fontWeight(.semibold)
                    }
                    .disabled(active && changedValues.isEmpty)
                }

                if scene.updateAvailable, let latest = scene.latestVersion {
                    Section {
                        AsyncButton {
                            await model.update(app, scene)
                            dismiss()
                        } label: {
                            Label("Update scene to version \(latest)", systemImage: "arrow.down.circle")
                        }
                    } footer: {
                        Text("The frame holds version \(scene.heldVersion.map(String.init) ?? "?"). Your settings stay.")
                    }
                }

                if !scene.missingSettingsGroups.isEmpty {
                    Section {
                        AsyncButton {
                            await model.grant(app, scene)
                            dismiss()
                        } label: {
                            Label("Give it the API keys it asks for", systemImage: "key")
                        }
                    } footer: {
                        Text("It asks for: \(scene.missingSettingsGroups.joined(separator: ", ")). Keys are delivered only to scenes you grant them to.")
                    }
                }

                Section {
                    Button(role: .destructive) {
                        confirmRemove = true
                    } label: {
                        Label("Remove from frame", systemImage: "trash")
                    }
                } footer: {
                    if scene.packSize > 1 {
                        Text("This scene came with \(scene.packSize - 1) more in one store scene; they are removed together.")
                    }
                }
            }
            .navigationTitle(scene.name)
            .inlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
            }
            .confirmationDialog("Remove \(scene.name)?", isPresented: $confirmRemove, titleVisibility: .visible) {
                Button("Remove", role: .destructive) {
                    Task {
                        await model.remove(app, scene)
                        dismiss()
                    }
                }
            } message: {
                Text(app.current?.kind == .backend
                    ? "The frame's list is saved without it and deployed."
                    : "The frame gets its list without it when it next checks in.")
            }
        }
    }

    /// What the person changed, over what the frame reported.
    var changedValues: [String: JSONValue] {
        var merged = model.values(for: scene)
        merged.merge(values) { _, new in new }
        // Activate sends every visible value; Apply only the changed ones matter, but sending all is harmless.
        return active ? values : merged.filter { key, _ in visibleFields.contains { $0.name == key } }
    }

    func binding(for field: SceneField) -> Binding<JSONValue> {
        Binding {
            values[field.name] ?? model.values(for: scene)[field.name] ?? field.defaultValue ?? .null
        } set: { newValue in
            values[field.name] = newValue
        }
    }
}

/// One public field, drawn for its type (the SPA's StateFieldInput for the
/// types a phone can edit; the rest as text).
struct SceneFieldEditor: View {
    let field: SceneField
    @Binding var value: JSONValue

    var text: Binding<String> {
        Binding { value.stringValue ?? (value.isNull ? "" : value.jsonString()) } set: { value = .string($0) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            switch field.type {
            case "boolean":
                Toggle(field.label, isOn: Binding { value.boolValue ?? false } set: { value = .bool($0) })
            case "select":
                Picker(field.label, selection: text) {
                    ForEach(field.options, id: \.value) { option in
                        Text(option.label).tag(option.value)
                    }
                    if !field.options.contains(where: { $0.value == text.wrappedValue }) && !text.wrappedValue.isEmpty {
                        Text(text.wrappedValue).tag(text.wrappedValue)
                    }
                }
            case "integer", "float":
                LabeledContent(field.label) {
                    TextField(field.placeholder ?? "", text: text)
                        .multilineTextAlignment(.trailing)
                        .numberInput(decimal: field.type == "float")
                }
            case "color":
                ColorPicker(field.label, selection: Binding {
                    Color(hex: text.wrappedValue) ?? .black
                } set: {
                    text.wrappedValue = $0.hexString
                }, supportsOpacity: false)
            case "text", "json":
                Text(field.label).font(.subheadline)
                TextField(field.placeholder ?? "", text: text, axis: .vertical)
                    .lineLimit(3...10)
                    .font(field.type == "json" ? .body.monospaced() : .body)
                    .plainInput()
            case "date":
                DatePicker(field.label, selection: Binding {
                    ISO8601DateFormatter.dateOnly.date(from: text.wrappedValue) ?? Date()
                } set: {
                    text.wrappedValue = ISO8601DateFormatter.dateOnly.string(from: $0)
                }, displayedComponents: .date)
            default:
                if field.secret {
                    SecureField(field.label, text: text)
                } else {
                    TextField(field.label, text: text, prompt: Text(field.placeholder ?? field.label))
                        .plainInput()
                }
            }
            if let hint = field.hint, !hint.isEmpty {
                Text(LocalizedStringKey(hint)).font(.caption).foregroundStyle(.secondary)
            }
        }
    }
}

extension ISO8601DateFormatter {
    static let dateOnly: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withFullDate]
        return formatter
    }()
}

extension Color {
    init?(hex: String) {
        var text = hex.trimmingCharacters(in: .whitespaces)
        if text.hasPrefix("#") { text.removeFirst() }
        if text.count == 3 { text = text.map { "\($0)\($0)" }.joined() }
        guard text.count == 6, let value = Int(text, radix: 16) else { return nil }
        self.init(red: Double((value >> 16) & 0xFF) / 255, green: Double((value >> 8) & 0xFF) / 255, blue: Double(value & 0xFF) / 255)
    }

    var hexString: String {
        let resolved = resolve(in: EnvironmentValues())
        let r = Int((resolved.red * 255).rounded()), g = Int((resolved.green * 255).rounded()), b = Int((resolved.blue * 255).rounded())
        return String(format: "#%02x%02x%02x", max(0, min(255, r)), max(0, min(255, g)), max(0, min(255, b)))
    }
}
