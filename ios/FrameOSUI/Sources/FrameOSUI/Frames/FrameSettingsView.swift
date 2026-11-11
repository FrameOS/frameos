import FrameOSKit
import SwiftUI

/// The frame's settings a phone edits (the SPA's settings panel, the part
/// that is not hardware wiring). On the cloud only the keys this frame's
/// profile and firmware take are drawn (docs/cloud-frames-contract.json);
/// on a backend, Save also deploys them.
struct FrameSettingsView: View {
    @Environment(AppModel.self) private var app
    let frameId: String
    @State private var edits: [String: JSONValue] = [:]
    @State private var name = ""

    var body: some View {
        if let frame = app.frame(frameId), let service = app.service {
            let keys = service.editableSettings(frame)
            Form {
                Section("Name") {
                    TextField("Name", text: $name)
                        .onAppear { name = frame.name }
                    if name.trimmingCharacters(in: .whitespaces) != frame.name && !name.trimmingCharacters(in: .whitespaces).isEmpty {
                        AsyncButton {
                            await app.perform("Rename") {
                                try await service.rename(frame, to: name.trimmingCharacters(in: .whitespaces))
                                await app.reloadFrame(frameId)
                                return ActionOutcome(kind: .done, message: "Renamed.")
                            }
                        } label: { Text("Rename") }
                    }
                }

                Section {
                    if keys.contains("rotate") {
                        Picker("Rotation", selection: intBinding("rotate", frame, fallback: 0)) {
                            ForEach([0, 90, 180, 270], id: \.self) { Text("\($0)°").tag($0) }
                        }
                    }
                    if keys.contains("scaling_mode") {
                        Picker("Scaling", selection: stringBinding("scaling_mode", frame, fallback: "contain")) {
                            Text("Contain").tag("contain")
                            Text("Cover").tag("cover")
                            Text("Stretch").tag("stretch")
                            Text("Center").tag("center")
                        }
                    }
                    if keys.contains("render_scale") {
                        Picker("Render scale", selection: doubleBinding("render_scale", frame, fallback: 0)) {
                            Text("Automatic").tag(0.0)
                            ForEach([1.0, 1.5, 2.0, 3.0, 4.0], id: \.self) { Text("\($0.formatted())×").tag($0) }
                        }
                    }
                    if keys.contains("flip") {
                        Picker("Flip", selection: stringBinding("flip", frame, fallback: "")) {
                            Text("None").tag("")
                            Text("Horizontal").tag("horizontal")
                            Text("Vertical").tag("vertical")
                            Text("Both").tag("both")
                        }
                    }
                } header: {
                    Text("Display")
                }

                Section {
                    if keys.contains("interval") {
                        LabeledContent("Render every (seconds)") {
                            TextField("300", value: doubleBinding("interval", frame, fallback: 300), format: .number)
                                .multilineTextAlignment(.trailing)
                                .numberInput()
                        }
                    }
                    if keys.contains("timezone") {
                        Picker("Time zone", selection: stringBinding("timezone", frame, fallback: "")) {
                            Text("Not set").tag("")
                            ForEach(TimeZone.knownTimeZoneIdentifiers, id: \.self) { Text($0).tag($0) }
                        }
                    }
                    if keys.contains("frame_settings_on_screen") {
                        Toggle("Settings on the frame's screen", isOn: boolBinding("frame_settings_on_screen", frame, fallback: true))
                    }
                    if keys.contains("debug") {
                        Toggle("Debug logging", isOn: boolBinding("debug", frame, fallback: false))
                    }
                } header: {
                    Text("Behaviour")
                } footer: {
                    if keys.contains("interval") {
                        Text("A scene's own refresh interval can make the frame render more often.")
                    }
                }

                if keys.contains("deep_sleep") || keys.contains("deep_sleep_on_battery") {
                    Section {
                        if keys.contains("deep_sleep") {
                            Toggle("Sleep between renders", isOn: boolBinding("deep_sleep", frame, fallback: false))
                        }
                        if keys.contains("deep_sleep_on_battery") {
                            Toggle("Sleep when on battery", isOn: boolBinding("deep_sleep_on_battery", frame, fallback: false))
                        }
                        if keys.contains("wake_check_seconds") {
                            LabeledContent("Check in every (seconds)") {
                                TextField("0", value: doubleBinding("wake_check_seconds", frame, fallback: 0), format: .number)
                                    .multilineTextAlignment(.trailing)
                                    .numberInput(decimal: false)
                            }
                        }
                    } header: {
                        Text("Power")
                    } footer: {
                        Text("A sleeping frame takes changes when it wakes.")
                    }
                }

                Section {
                    AsyncButton {
                        let changes = edits
                        await app.perform("Save") {
                            let outcome = try await service.saveSettings(frame, changes)
                            await MainActor.run { edits = [:] }
                            await app.reloadFrame(frameId)
                            return outcome
                        }
                    } label: {
                        Text(app.current?.kind == .backend ? "Save & deploy" : "Save").frame(maxWidth: .infinity).fontWeight(.semibold)
                    }
                    .disabled(edits.isEmpty)
                } footer: {
                    Text("Wiring, drivers, the network and the rest are in the web workspace.")
                }
            }
            .navigationTitle("Settings")
            .inlineTitle()
        }
    }

    func current(_ key: String, _ frame: Frame) -> JSONValue? { edits[key] ?? frame[key].nonNullValue }

    func intBinding(_ key: String, _ frame: Frame, fallback: Int) -> Binding<Int> {
        Binding { current(key, frame)?.intValue ?? fallback } set: { edits[key] = .number(Double($0)) }
    }

    func doubleBinding(_ key: String, _ frame: Frame, fallback: Double) -> Binding<Double> {
        Binding { current(key, frame)?.doubleValue ?? fallback } set: { edits[key] = .number($0) }
    }

    func stringBinding(_ key: String, _ frame: Frame, fallback: String) -> Binding<String> {
        Binding { current(key, frame)?.stringValue ?? fallback } set: { edits[key] = .string($0) }
    }

    func boolBinding(_ key: String, _ frame: Frame, fallback: Bool) -> Binding<Bool> {
        Binding { current(key, frame)?.boolValue ?? fallback } set: { edits[key] = .bool($0) }
    }
}

extension Optional where Wrapped == JSONValue {
    var nonNullValue: JSONValue? {
        if case .some(let value) = self, !value.isNull { return value }
        return nil
    }
}

/// When the frame switches scenes by itself (`frame.schedule`).
struct ScheduleView: View {
    @Environment(AppModel.self) private var app
    let frameId: String
    let scenes: [InstalledScene]
    @State private var events: [ScheduleEvent] = []
    @State private var disabled = false
    @State private var loaded = false
    @State private var changed = false
    @State private var adding = false

    var body: some View {
        Form {
            Section {
                Toggle("Schedule on", isOn: Binding { !disabled } set: { disabled = !$0; changed = true })
            }
            Section {
                if events.isEmpty { Text("Nothing scheduled.").foregroundStyle(.secondary) }
                ForEach($events) { $event in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text(String(format: "%02d:%02d", event.hour, event.minute)).font(.headline.monospacedDigit())
                            Text(ScheduleEvent.weekdayNames[safe: event.weekday] ?? "").foregroundStyle(.secondary)
                            Spacer()
                            Toggle("", isOn: Binding { !event.disabled } set: { event.disabled = !$0; changed = true })
                                .labelsHidden()
                        }
                        Text(describe(event)).font(.caption).foregroundStyle(.secondary)
                    }
                }
                .onDelete { events.remove(atOffsets: $0); changed = true }
                Button { adding = true } label: { Label("Add", systemImage: "plus") }
            } header: {
                Text("Events")
            } footer: {
                Text("Times are the frame's own time zone.")
            }
            Section {
                AsyncButton {
                    guard let service = app.service, let frame = app.frame(frameId) else { return }
                    let list = events, off = disabled
                    await app.perform("Save schedule") {
                        let outcome = try await service.saveSchedule(frame, events: list, disabled: off)
                        await app.reloadFrame(frameId)
                        await MainActor.run { changed = false }
                        return outcome
                    }
                } label: { Text("Save").frame(maxWidth: .infinity).fontWeight(.semibold) }
                .disabled(!changed)
            }
        }
        .navigationTitle("Schedule")
        .inlineTitle()
        .onAppear {
            guard !loaded, let frame = app.frame(frameId), let service = app.service else { return }
            let schedule = service.schedule(frame)
            events = schedule.events
            disabled = schedule.disabled
            loaded = true
        }
        .sheet(isPresented: $adding) {
            AddScheduleEventSheet(scenes: scenes) { event in
                events.append(event)
                events.sort { ($0.hour, $0.minute) < ($1.hour, $1.minute) }
                changed = true
            }
        }
    }

    func describe(_ event: ScheduleEvent) -> String {
        if event.event == "setCurrentScene" {
            let name = scenes.first { $0.id == event.sceneId || $0.storeSceneId == event.sceneId }?.name ?? event.sceneId ?? "a scene"
            return "Show \(name)"
        }
        return event.event
    }
}

struct AddScheduleEventSheet: View {
    @Environment(\.dismiss) private var dismiss
    let scenes: [InstalledScene]
    let add: (ScheduleEvent) -> Void
    @State private var time = Calendar.current.date(bySettingHour: 8, minute: 0, second: 0, of: Date()) ?? Date()
    @State private var weekday = 0
    @State private var sceneId = ""

    var body: some View {
        NavigationStack {
            Form {
                DatePicker("Time", selection: $time, displayedComponents: .hourAndMinute)
                Picker("Days", selection: $weekday) {
                    ForEach(Array(ScheduleEvent.weekdayNames.enumerated()), id: \.offset) { index, name in
                        Text(name).tag(index)
                    }
                }
                Picker("Scene", selection: $sceneId) {
                    Text("Choose").tag("")
                    ForEach(scenes) { Text($0.name).tag($0.id) }
                }
            }
            .navigationTitle("Add to schedule")
            .inlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add") {
                        let parts = Calendar.current.dateComponents([.hour, .minute], from: time)
                        add(ScheduleEvent.new(sceneId: sceneId, hour: parts.hour ?? 0, minute: parts.minute ?? 0, weekday: weekday))
                        dismiss()
                    }
                    .disabled(sceneId.isEmpty)
                }
            }
        }
    }
}

extension Array {
    subscript(safe index: Int) -> Element? { indices.contains(index) ? self[index] : nil }
}

/// The frame's own button map ("Button actions", the SPA's section of the
/// same name): one press of one button or one swipe, and what it does,
/// whatever scene shows. Rules the section did not write are kept.
struct ButtonMapView: View {
    @Environment(AppModel.self) private var app
    let frameId: String
    let scenes: [InstalledScene]
    @State private var bindings: [ButtonBinding] = []
    @State private var others: [JSONValue] = []
    @State private var usesPreset = true
    @State private var loaded = false
    @State private var changed = false
    @State private var adding = false

    var body: some View {
        Form {
            Section {
                if usesPreset {
                    Text("This frame runs its board's own buttons. Add a row to set them here instead.")
                        .foregroundStyle(.secondary)
                }
                ForEach(bindings) { binding in
                    LabeledContent(ButtonBindings.gestureTitle(binding.gesture)) {
                        Text(ButtonBindings.actionTitle(binding) { id in scenes.first { $0.id == id }?.name })
                    }
                }
                .onDelete { bindings.remove(atOffsets: $0); changed = true }
                ForEach(Array(others.enumerated()), id: \.offset) { _, rule in
                    Text(ButtonBindings.describe(rule)).font(.callout).foregroundStyle(.secondary)
                }
                Button { adding = true } label: { Label("Add", systemImage: "plus") }
            } header: {
                Text("Buttons and swipes")
            } footer: {
                Text("A bound press does its action whatever scene shows; the scene never hears it.")
            }
            Section {
                AsyncButton {
                    guard let service = app.service, let frame = app.frame(frameId) else { return }
                    let rules = ButtonBindings.rules(bindings, others: others)
                    await app.perform("Save button actions") {
                        let outcome = try await service.saveEventMap(frame, rules: rules)
                        await app.reloadFrame(frameId)
                        await MainActor.run { changed = false; usesPreset = false }
                        return outcome
                    }
                } label: { Text(app.current?.kind == .backend ? "Save & deploy" : "Save").frame(maxWidth: .infinity).fontWeight(.semibold) }
                .disabled(!changed)
            }
        }
        .navigationTitle("Button actions")
        .inlineTitle()
        .onAppear {
            guard !loaded, let frame = app.frame(frameId), let service = app.service else { return }
            if let rules = service.eventMap(frame) {
                let split = ButtonBindings.split(rules)
                bindings = split.bindings
                others = split.others
                usesPreset = false
            }
            loaded = true
        }
        .sheet(isPresented: $adding) {
            AddBindingSheet(scenes: scenes, voice: app.frame(frameId).map { Microphone.present($0, plane: app.current?.kind ?? .cloud) } ?? false) { binding in
                bindings.append(binding)
                changed = true
            }
        }
    }
}

struct AddBindingSheet: View {
    @Environment(\.dismiss) private var dismiss
    let scenes: [InstalledScene]
    let voice: Bool
    let add: (ButtonBinding) -> Void
    @State private var isSwipe = false
    @State private var label = ""
    @State private var press = "longPress"
    @State private var edge = "left"
    @State private var kind = "nextScene"
    @State private var sceneId = ""

    var body: some View {
        NavigationStack {
            Form {
                Section("When") {
                    Picker("Input", selection: $isSwipe) {
                        Text("A button").tag(false)
                        Text("A swipe").tag(true)
                    }
                    .pickerStyle(.segmented)
                    if isSwipe {
                        Picker("Swipe", selection: $edge) {
                            ForEach(ButtonBindings.screenEdges, id: \.self) { Text(ButtonBindings.gestureTitle(.edge($0))).tag($0) }
                        }
                    } else {
                        TextField("Button label, as the frame names it (LEFT, KEY1…)", text: $label).plainInput()
                        Picker("Press", selection: $press) {
                            Text("Press").tag("press")
                            Text("Double press").tag("doublePress")
                            Text("Long press").tag("longPress")
                        }
                    }
                }
                Section("Do") {
                    Picker("Action", selection: $kind) {
                        ForEach(ButtonBindings.actionKinds + ["showScene"] + (voice ? ["voiceChat"] : []), id: \.self) {
                            Text(ButtonBindings.actionTitles[$0] ?? $0).tag($0)
                        }
                    }
                    if kind == "showScene" {
                        Picker("Scene", selection: $sceneId) {
                            Text("Choose").tag("")
                            ForEach(scenes) { Text($0.name).tag($0.id) }
                        }
                    }
                }
            }
            .navigationTitle("Add")
            .inlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add") {
                        let gesture: ButtonBinding.Gesture = isSwipe
                            ? .edge(edge) : .button(label: label.trimmingCharacters(in: .whitespaces), action: press)
                        add(ButtonBinding(gesture: gesture, kind: kind, sceneId: kind == "showScene" ? sceneId : nil))
                        dismiss()
                    }
                    .disabled((!isSwipe && label.trimmingCharacters(in: .whitespaces).isEmpty) || (kind == "showScene" && sceneId.isEmpty))
                }
            }
        }
    }
}

/// What the voice chat may do on this frame (four switches, all on by default).
struct VoicePermissionsView: View {
    @Environment(AppModel.self) private var app
    let frameId: String
    @State private var permissions = VoicePermissions()
    @State private var loaded = false

    var body: some View {
        Form {
            Section {
                ForEach(VoicePermissions.keys, id: \.self) { key in
                    Toggle(VoicePermissions.titles[key] ?? key, isOn: Binding {
                        permissions.values[key] ?? true
                    } set: { value in
                        permissions.values[key] = value
                        save()
                    })
                }
            } footer: {
                Text("Hold the frame's voice key and talk: these decide what the AI may do there.")
            }
        }
        .navigationTitle("Voice chat")
        .inlineTitle()
        .onAppear {
            guard !loaded, let frame = app.frame(frameId), let kind = app.current?.kind else { return }
            permissions = VoicePermissions.of(frame, plane: kind)
            loaded = true
        }
    }

    func save() {
        guard let service = app.service, let frame = app.frame(frameId) else { return }
        let value = permissions
        Task {
            do {
                try await service.saveVoicePermissions(frame, value)
                await app.reloadFrame(frameId)
            } catch {
                app.show("Could not save: \(error.localizedDescription)", tone: .failure)
            }
        }
    }
}
