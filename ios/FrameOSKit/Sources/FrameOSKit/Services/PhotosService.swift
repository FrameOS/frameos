import Foundation

/// A photo or an album (folder) in the library (docs/photos.md "Entry";
/// the same shape on both planes).
public struct PhotoEntry: Identifiable, Hashable, Sendable {
    public var raw: [String: JSONValue]
    public init(raw: [String: JSONValue]) { self.raw = raw }

    public var id: String { path }
    public var path: String { raw["path"]?.stringValue ?? "" }
    public var name: String { raw["name"]?.stringValue ?? path }
    public var isFolder: Bool { raw["kind"]?.stringValue == "folder" }
    public var size: Int { raw["size"]?.intValue ?? 0 }
    public var mtime: Double { raw["mtime"]?.doubleValue ?? 0 }
    public var width: Int? { raw["width"]?.intValue }
    public var height: Int? { raw["height"]?.intValue }
    public var contentType: String? { raw["content_type"]?.stringValue }
    public var items: Int { raw["items"]?.intValue ?? 0 }
    public var files: Int { raw["files"]?.intValue ?? 0 }
    public var cover: String? { raw["cover"]?.stringValue }
    public var colors: JSONValue? { raw["colors"].flatMap { $0.isNull ? nil : $0 } }
    public var hasLocation: Bool { raw["location"].map { !$0.isNull } ?? false }
    public var isBlocked: Bool { raw["status"]?.stringValue == "blocked" }
    /// The SPA's thumbnail cache key (`v=<mtime>-<size>`).
    public var version: String { "\(Int(mtime))-\(size)" }
}

public struct PhotoShare: Identifiable, Hashable, Sendable {
    public var raw: [String: JSONValue]
    public init(raw: [String: JSONValue]) { self.raw = raw }
    public var id: String { token }
    public var token: String { raw["token"]?.stringValue ?? "" }
    public var path: String { raw["path"]?.stringValue ?? "" }
    public var frameId: String? { raw["frame_id"]?.stringValue }
    public var name: String? { raw["name"]?.stringValue }
    public var url: String { raw["url"]?.stringValue ?? "" }
    public var lastUsedAt: Double? { raw["last_used_at"]?.doubleValue }
}

public struct PhotosStatus: Sendable {
    public var ready: Bool
    public var message: String?
    public var usedBytes: Int
    public var quotaBytes: Int?
    public var maxUploadBytes: Int?
    public var accepts: [String]
}

/// The order and fit of an album scene (`POST /api/photos/scene`).
public struct AlbumOptions: Sendable, Hashable {
    public var seconds: Double = 3600
    public var order: String = "random"
    public var fit: String = "cover"
    public var name: String?
    public init(seconds: Double = 3600, order: String = "random", fit: String = "cover", name: String? = nil) {
        self.seconds = seconds
        self.order = order
        self.fit = fit
        self.name = name
    }
}

/// The library, through the one HTTP contract both planes serve
/// (docs/photos.md; `/api/photos/...`, project-scoped on a backend).
extension FrameOSService {
    public func photosStatus() async throws -> PhotosStatus {
        let answer = try await client.get("/api/photos/status")
        return PhotosStatus(
            ready: answer["ready"]?.boolValue ?? false, message: answer["message"]?.stringValue,
            usedBytes: answer["used_bytes"]?.intValue ?? 0, quotaBytes: answer["quota_bytes"]?.intValue,
            maxUploadBytes: answer["max_upload_bytes"]?.intValue,
            accepts: answer["accepts"]?.arrayValue?.compactMap(\.stringValue) ?? ["image/jpeg", "image/png", "image/gif", "image/webp"]
        )
    }

    public func photos(in folder: String) async throws -> [PhotoEntry] {
        let answer = try await client.get("/api/photos/files", query: ["path": folder])
        return (answer["entries"]?.arrayValue ?? []).compactMap { $0.objectValue }.map(PhotoEntry.init)
    }

    public func photoThumbnail(_ path: String, version: String) async throws -> Data {
        try await client.bytes("/api/photos/thumb", query: ["path": path, "v": version]).0
    }

    public func photoFile(_ path: String) async throws -> Data {
        try await client.bytes("/api/photos/file", query: ["path": path], timeout: 120).0
    }

    /// Upload one photo, byte for byte, in ≤ 4 MiB chunks. A name already
    /// taken comes back as `name (2).jpg`.
    @discardableResult
    public func uploadPhoto(folder: String, filename: String, data: Data,
                            progress: (@Sendable (Double) -> Void)? = nil) async throws -> String
    {
        var attempt = 0
        while true {
            do {
                try await uploadChunks(path: "/api/photos/upload", base: ["path": folder, "filename": filename],
                                       data: data, chunkSize: 4 * 1024 * 1024, idLength: 32, chunkIndex: false, progress: progress)
                return filename
            } catch let error as APIError where error.status == 409 && error.code != "exists" && attempt == 0 {
                attempt += 1
            }
        }
    }

    @discardableResult
    public func createAlbum(_ path: String) async throws -> PhotoEntry {
        let answer = try await client.call("POST", "/api/photos/folders", body: .json(["path": .string(path)]))
        return PhotoEntry(raw: answer["entry"]?.objectValue ?? [:])
    }

    public func renamePhoto(_ path: String, to name: String) async throws {
        try await client.call("POST", "/api/photos/rename", body: .json(["path": .string(path), "name": .string(name)]))
    }

    public func movePhotos(_ paths: [String], to folder: String) async throws {
        try await client.call("POST", "/api/photos/move", body: .json([
            "paths": .array(paths.map { .string($0) }), "to": .string(folder),
        ]))
    }

    public func deletePhotos(_ paths: [String]) async throws {
        try await client.call("POST", "/api/photos/delete", body: .json(["paths": .array(paths.map { .string($0) })]))
    }

    /// The color profile (docs/asset-color-profiles.md); nil removes it.
    public func setPhotoColors(_ path: String, colors: JSONValue?) async throws {
        try await client.call("POST", "/api/photos/colors", body: .json(["path": .string(path), "colors": colors ?? .null]))
    }

    /// Remove the location, or every piece of metadata, when the owner asks.
    public func removePhotoMetadata(_ paths: [String], everything: Bool) async throws {
        try await client.call("POST", "/api/photos/metadata", body: .json([
            "paths": .array(paths.map { .string($0) }), "remove": everything ? "all" : "location",
        ]))
    }

    public func photoMetadata(_ path: String) async throws -> JSONValue {
        try await client.get("/api/photos/metadata", query: ["path": path])["metadata"] ?? .null
    }

    public func photoShares() async throws -> [PhotoShare] {
        let answer = try await client.get("/api/photos/shares")
        return (answer["shares"]?.arrayValue ?? []).compactMap { $0.objectValue }.map(PhotoShare.init)
    }

    public func createShare(path: String, name: String?) async throws -> PhotoShare {
        var body: [String: JSONValue] = ["path": .string(path)]
        if let name, !name.isEmpty { body["name"] = .string(name) }
        let answer = try await client.call("POST", "/api/photos/shares", body: .json(.object(body)))
        return PhotoShare(raw: answer["share"]?.objectValue ?? [:])
    }

    public func deleteShare(_ share: PhotoShare) async throws {
        try await client.call("DELETE", "/api/photos/shares/\(ApiPaths.segment(share.token))")
    }

    /// An absolute link for a share (a backend's `url` is relative).
    public func shareURL(_ share: PhotoShare) -> String {
        if share.url.hasPrefix("http") { return share.url }
        return account.baseURL.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + share.url
    }

    /// Play an album on a frame: the frame's own share link and the album
    /// scene, built by the plane (`POST /api/photos/scene`, the scene
    /// docs/photo-album-scene.json pins), then installed. Cloud: saved as a
    /// private scene and added in one push; backend: the backend's own
    /// `photo_album_install` (the scene installed with its ids kept).
    public func installAlbum(_ path: String, on frame: Frame, options: AlbumOptions, activate: Bool) async throws -> ActionOutcome {
        switch kind {
        case .cloud:
            var body: [String: JSONValue] = [
                "path": .string(path), "frame_id": .string(frame.id), "seconds": .number(options.seconds),
                "order": .string(options.order), "fit": .string(options.fit),
            ]
            if let name = options.name, !name.isEmpty { body["name"] = .string(name) }
            let built = try await client.call("POST", "/api/photos/scene", body: .json(.object(body)))
            guard let scene = built["scene"] else { throw APIError(status: 0, message: "The album scene was not built.") }
            let created = try await client.call("POST", "/api/account/scenes", body: .json([
                "name": scene["name"] ?? .string(options.name ?? path), "scenes": .array([scene]),
            ]))
            guard let storeId = created["scene"]?["id"]?.stringValue else {
                throw APIError(status: 0, message: "The album scene could not be saved.")
            }
            try await client.call("POST", Self.framePath(frame.id, "/scenes/add"), body: .json([
                "scene_id": .string(storeId), "activate": .bool(activate),
            ]))
            return ActionOutcome(kind: .queued, message: "The album is on the frame's list. It shows when the frame next checks in.")
        case .backend:
            var arguments: [String: JSONValue] = [
                "confirm": true, "frame_id": .number(Double(Int(frame.id) ?? 0)), "path": .string(path),
                "activate": .bool(activate), "seconds": .number(options.seconds), "order": .string(options.order),
                "fit": .string(options.fit),
            ]
            if let name = options.name, !name.isEmpty { arguments["name"] = .string(name) }
            if let projectId = account.projectId { arguments["project_id"] = .number(Double(projectId)) }
            _ = try await client.mcpTool("photo_album_install", arguments: arguments)
            return ActionOutcome(kind: .done, message: "The album is on the frame and deploying.")
        }
    }
}
