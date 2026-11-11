import FrameOSKit
import Observation
import SwiftUI

/// The frame page's state (the SPA's frameLogic + scenesLogic + controlLogic,
/// for what a phone does): the scene list, the values of the scenes'
/// fields, what is waiting for the frame, and the frame-wide actions.
@Observable @MainActor
final class FrameDetailModel {
    let frameId: String
    var scenes: [InstalledScene] = []
    var scenesLoading = false
    var scenesError: String?
    var states = FrameStates()
    var commands: [PendingCommand] = []
    var latestRelease: String?
    var imageNonce = 0
    /// Cloud: scenes the frame ran before it joined, waiting to be imported.
    var deviceScenes: (count: Int, names: [String])?

    init(frameId: String) { self.frameId = frameId }

    func load(_ app: AppModel) async {
        guard let service = app.service else { return }
        await app.reloadFrame(frameId)
        guard let frame = app.frame(frameId) else { return }
        async let scenes: Void = loadScenes(service, frame)
        async let states: Void = loadStates(service, frame)
        async let commands: Void = loadCommands(service, frame)
        async let release: Void = loadRelease(service)
        async let brought: Void = loadDeviceScenes(service, frame)
        _ = await (scenes, states, commands, release, brought)
    }

    func loadDeviceScenes(_ service: FrameOSService, _ frame: Frame) async {
        deviceScenes = try? await service.deviceScenes(frame)
    }

    func resolveDeviceScenes(_ app: AppModel, importThem: Bool) async {
        guard let service = app.service, let frame = app.frame(frameId) else { return }
        await app.perform(importThem ? "Import" : "Dismiss") { try await service.resolveDeviceScenes(frame, importThem: importThem) }
        await load(app)
    }

    func confirm(_ app: AppModel) async {
        guard let service = app.service, let frame = app.frame(frameId) else { return }
        await app.perform("Confirm") {
            try await service.confirmFrame(frame)
            return ActionOutcome(kind: .done, message: "Confirmed. The frame is yours.")
        }
        await load(app)
    }

    func loadScenes(_ service: FrameOSService, _ frame: Frame) async {
        scenesLoading = true
        defer { scenesLoading = false }
        do {
            scenes = try await service.installedScenes(frame)
            scenesError = nil
        } catch {
            scenesError = error.localizedDescription
        }
    }

    func loadStates(_ service: FrameOSService, _ frame: Frame) async {
        var attempts = 0
        while attempts < 3 {
            attempts += 1
            guard let fresh = try? await service.states(frame) else { break }
            states = fresh
            guard fresh.refreshing, let wait = fresh.retryAfter else { break }
            try? await Task.sleep(nanoseconds: UInt64(max(1, min(wait, 10)) * 1_000_000_000))
        }
        if states.activeSceneId == nil { states.activeSceneId = service.activeSceneId(frame) }
    }

    func loadCommands(_ service: FrameOSService, _ frame: Frame) async {
        commands = (try? await service.commands(frame)) ?? []
    }

    func loadRelease(_ service: FrameOSService) async {
        if latestRelease == nil { latestRelease = try? await service.latestRelease() }
    }

    /// Scenes shown on the list: no layouts, no built-ins.
    var listedScenes: [InstalledScene] {
        scenes.filter { !$0.isLayout && !SceneIds.isBuiltIn($0.id) }
    }

    func isActive(_ scene: InstalledScene) -> Bool {
        SceneIds.refer(states.activeSceneId, scene.id)
    }

    func values(for scene: InstalledScene) -> [String: JSONValue] {
        states.states[SceneIds.publicId(scene.id)] ?? [:]
    }

    /// A newer FrameOS than the frame runs.
    func updateAvailable(_ frame: Frame) -> Bool {
        guard let release = latestRelease?.trimmingCharacters(in: CharacterSet(charactersIn: "v")),
              let running = frame.frameosVersion?.trimmingCharacters(in: CharacterSet(charactersIn: "v")),
              !release.isEmpty, !running.isEmpty else { return false }
        return release.compare(running, options: .numeric) == .orderedDescending
    }

    // MARK: actions

    func activate(_ app: AppModel, _ scene: InstalledScene, state: [String: JSONValue] = [:]) async {
        guard let service = app.service, let frame = app.frame(frameId) else { return }
        await app.perform("Activate") {
            let outcome = try await service.activate(frame, sceneId: scene.id, state: state)
            await MainActor.run {
                self.states.activeSceneId = scene.id
                if !state.isEmpty {
                    var merged = self.states.states[SceneIds.publicId(scene.id)] ?? [:]
                    merged.merge(state) { _, new in new }
                    self.states.states[SceneIds.publicId(scene.id)] = merged
                }
            }
            return outcome
        }
        await loadCommands(service, frame)
    }

    func remove(_ app: AppModel, _ scene: InstalledScene) async {
        guard let service = app.service, let frame = app.frame(frameId) else { return }
        await app.perform("Remove") { try await service.removeScene(frame, scene) }
        await load(app)
    }

    func update(_ app: AppModel, _ scene: InstalledScene) async {
        guard let service = app.service, let frame = app.frame(frameId), let storeId = scene.storeSceneId else { return }
        await app.perform("Update") { try await service.updateScene(frame, storeSceneId: storeId) }
        await load(app)
    }

    func grant(_ app: AppModel, _ scene: InstalledScene) async {
        guard let service = app.service, let frame = app.frame(frameId), let storeId = scene.storeSceneId else { return }
        await app.perform("Grant API keys") {
            try await service.grantSettings(frame, storeSceneId: storeId, groups: scene.declaredSettingsGroups)
            return ActionOutcome(kind: .queued, message: "Granted. The scene gets the keys with its next push.")
        }
        await load(app)
    }

    func installPreview(_ app: AppModel) async {
        guard let service = app.service, let frame = app.frame(frameId) else { return }
        await app.perform("Install") { try await service.installPreview(frame) }
        await load(app)
    }

    func discardPreview(_ app: AppModel) async {
        guard let service = app.service, let frame = app.frame(frameId) else { return }
        await app.perform("Discard") { try await service.discardPreview(frame) }
        await load(app)
    }

    func cancel(_ app: AppModel, _ command: PendingCommand) async {
        guard let service = app.service, let frame = app.frame(frameId) else { return }
        do {
            try await service.cancelCommand(frame, command)
            commands.removeAll { $0.id == command.id }
        } catch {
            app.show("Could not cancel: \(error.localizedDescription)", tone: .failure)
            await loadCommands(service, frame)
        }
    }

    func run(_ app: AppModel, _ title: String, _ action: @escaping (FrameOSService, Frame) async throws -> ActionOutcome) async {
        guard let service = app.service, let frame = app.frame(frameId) else { return }
        await app.perform(title) { try await action(service, frame) }
        await app.reloadFrame(frameId)
        if let fresh = app.frame(frameId) { await loadCommands(service, fresh) }
    }

    func refreshImage(_ app: AppModel) {
        app.imageVersions[frameId, default: 0] += 1
        imageNonce += 1
    }
}
