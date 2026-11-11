import Charts
import FrameOSKit
import SwiftUI

/// The frame's log, newest at the bottom, live while it is open.
struct LogsView: View {
    @Environment(AppModel.self) private var app
    let frameId: String
    @State private var lines: [LogLine] = []
    @State private var loading = false
    @State private var error: String?
    @State private var filter = ""
    @State private var onlyProblems = false
    @State private var listener: UUID?

    var shown: [LogLine] {
        lines.filter { line in
            (!onlyProblems || line.isError) && (filter.isEmpty || line.line.localizedCaseInsensitiveContains(filter))
        }
    }

    var body: some View {
        ScrollViewReader { proxy in
            List {
                if let error { Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.orange) }
                ForEach(shown) { line in
                    LogRow(line: line).id(line.id)
                }
            }
            .listStyle(.plain)
            .font(.caption.monospaced())
            .onChange(of: lines.count) { _, _ in
                if let last = shown.last { withAnimation { proxy.scrollTo(last.id, anchor: .bottom) } }
            }
        }
        .overlay { if loading && lines.isEmpty { ProgressView() } }
        .searchable(text: $filter, prompt: "Filter")
        .navigationTitle("Logs")
        .inlineTitle()
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Toggle(isOn: $onlyProblems) { Image(systemName: "exclamationmark.triangle") }
                    .toggleStyle(.button)
                    .accessibilityLabel("Only problems")
            }
        }
        .task { await load() }
        .refreshable { await load() }
        .onAppear {
            listener = app.logBus.onLog { line in
                guard line.frameId == frameId, !lines.contains(where: { $0.id == line.id }) else { return }
                lines.append(line)
                if lines.count > 2000 { lines.removeFirst(lines.count - 2000) }
            }
        }
        .onDisappear { if let listener { app.logBus.remove(listener) } }
    }

    func load() async {
        guard let service = app.service, let frame = app.frame(frameId) else { return }
        loading = true
        defer { loading = false }
        do {
            lines = try await service.logs(frame, limit: 500).sorted { $0.id < $1.id }
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}

struct LogRow: View {
    let line: LogLine

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Text(timeWords).foregroundStyle(.secondary)
                if let event = line.event {
                    Text(event).fontWeight(.semibold).foregroundStyle(line.isError ? .red : Brand.teal)
                } else if line.type != "webhook" {
                    Text(line.type).foregroundStyle(.secondary)
                }
            }
            Text(body(of: line))
                .foregroundStyle(line.isError ? .red : .primary)
                .textSelection(.enabled)
                .lineLimit(8)
        }
        .padding(.vertical, 2)
    }

    var timeWords: String {
        guard let ms = FrameTime.parse(line.timestamp) else { return line.timestamp }
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm:ss"
        return formatter.string(from: Date(timeIntervalSince1970: ms / 1000))
    }

    func body(of line: LogLine) -> String {
        guard var payload = line.payload?.objectValue else { return line.line }
        payload["event"] = nil
        if payload.isEmpty { return "" }
        return payload.sorted { $0.key < $1.key }.map { "\($0.key): \($0.value.stringValue ?? $0.value.jsonString())" }
            .joined(separator: "  ")
    }
}

/// The frame's metrics over time, one chart per reading.
struct MetricsView: View {
    @Environment(AppModel.self) private var app
    let frameId: String
    @State private var samples: [MetricSample] = []
    @State private var loading = false
    @State private var error: String?
    @State private var listener: UUID?

    /// Every numeric reading the frame reports, with a readable name.
    var series: [(key: String, points: [(Date, Double)])] {
        var keys = Set<String>()
        for sample in samples {
            for (key, value) in sample.metrics where value.numberValueIfNumberPublic != nil { keys.insert(key) }
        }
        return keys.sorted().map { key in
            let points = samples.compactMap { sample -> (Date, Double)? in
                guard let ms = FrameTime.parse(sample.timestamp), let value = sample.metrics[key]?.numberValueIfNumberPublic else { return nil }
                return (Date(timeIntervalSince1970: ms / 1000), value)
            }
            return (key, points)
        }
    }

    var body: some View {
        List {
            if let error { Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.orange) }
            if samples.isEmpty && !loading {
                Text("No metrics yet.").foregroundStyle(.secondary)
            }
            ForEach(series, id: \.key) { serie in
                Section(Self.title(serie.key)) {
                    if let last = serie.points.last {
                        Text(last.1.formatted(.number.precision(.fractionLength(0...2)))).font(.title3.weight(.semibold))
                    }
                    Chart(serie.points, id: \.0) { point in
                        LineMark(x: .value("Time", point.0), y: .value(serie.key, point.1))
                            .foregroundStyle(Brand.teal)
                    }
                    .frame(height: 120)
                }
            }
        }
        .groupedList()
        .overlay { if loading && samples.isEmpty { ProgressView() } }
        .navigationTitle("Metrics")
        .inlineTitle()
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                AsyncButton {
                    guard let service = app.service, let frame = app.frame(frameId) else { return }
                    try? await service.requestMetrics(frame)
                    app.show("Asked the frame for fresh metrics.")
                } label: { Image(systemName: "arrow.clockwise") }
                .accessibilityLabel("Ask the frame for fresh metrics")
            }
        }
        .task { await load() }
        .refreshable { await load() }
        .onAppear {
            listener = app.logBus.onMetrics { id, sample in
                guard id == frameId else { return }
                samples.append(sample)
            }
        }
        .onDisappear { if let listener { app.logBus.remove(listener) } }
    }

    func load() async {
        guard let service = app.service, let frame = app.frame(frameId) else { return }
        loading = true
        defer { loading = false }
        do {
            samples = try await service.metrics(frame)
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    static func title(_ key: String) -> String {
        let known: [String: String] = [
            "cpuTemperature": "CPU temperature (°C)", "load": "Load", "memoryUsage": "Memory used (%)",
            "batteryPercent": "Battery (%)", "batteryMillivolts": "Battery (mV)", "freeHeap": "Free memory",
            "rssi": "Wi-Fi signal (dBm)", "uptime": "Uptime (s)",
        ]
        if let title = known[key] { return title }
        // camelCase → words
        var words = ""
        for character in key {
            if character.isUppercase && !words.isEmpty { words.append(" ") }
            words.append(character)
        }
        return words.prefix(1).uppercased() + words.dropFirst().lowercased()
    }
}

extension JSONValue {
    var numberValueIfNumberPublic: Double? {
        if case .number(let value) = self { return value }
        return nil
    }
}
