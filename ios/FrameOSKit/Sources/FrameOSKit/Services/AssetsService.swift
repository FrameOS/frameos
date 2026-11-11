import Foundation

/// A file or folder on the frame (the Assets panel). `path` is relative to
/// the frame's assets folder on both planes.
public struct AssetEntry: Identifiable, Hashable, Sendable {
    public var path: String
    public var size: Int
    public var mtime: Double?
    public var isDir: Bool

    public var id: String { path }
    public var name: String { path.split(separator: "/").last.map(String.init) ?? path }
    public var isImage: Bool {
        let ext = (name as NSString).pathExtension.lowercased()
        return ["png", "jpg", "jpeg", "gif", "webp", "bmp", "heic", "avif", "svg"].contains(ext)
    }
}

public struct AssetListing: Sendable {
    public var entries: [AssetEntry]
    /// The plane is asking the frame: list again after `retryAfter` seconds.
    public var refreshing: Bool
    public var retryAfter: Double?
    /// ESP32: false when no SD card is in.
    public var mounted: Bool?
}

extension FrameOSService {
    /// The frame's assets folder (`assets_path`, `/srv/assets` by default).
    func assetsRoot(_ frame: Frame) -> String {
        let root = frame["assets_path"]?.stringValue ?? "/srv/assets"
        return root.hasSuffix("/") ? String(root.dropLast()) : root
    }

    /// A backend lists absolute paths; the routes take relative ones (the SPA's assetPathKey).
    func relativeAssetPath(_ path: String, _ frame: Frame) -> String {
        let root = assetsRoot(frame)
        if path == root { return "" }
        if path.hasPrefix(root + "/") { return String(path.dropFirst(root.count + 1)) }
        return path.hasPrefix("/") ? String(path.dropFirst()) : path
    }

    /// One folder's direct children (`""` = the top), folders first.
    public func assets(_ frame: Frame, folder: String, refresh: Bool = false) async throws -> AssetListing {
        let answer = try await client.get(Self.framePath(frame.id, "/assets"),
                                          query: ["folder": folder, "refresh": refresh ? "1" : nil], timeout: 45)
        let prefix = folder.isEmpty ? "" : folder + "/"
        var seen = Set<String>()
        var entries: [AssetEntry] = []
        for item in answer["assets"]?.arrayValue ?? [] {
            guard let raw = item["path"]?.stringValue else { continue }
            let path = relativeAssetPath(raw, frame)
            guard path.hasPrefix(prefix), path != folder else { continue }
            let rest = path.dropFirst(prefix.count)
            // A whole-tree answer: keep this folder's children, folders from deeper paths.
            if let slash = rest.firstIndex(of: "/") {
                let child = prefix + rest[..<slash]
                if seen.insert(child).inserted { entries.append(AssetEntry(path: child, size: 0, mtime: nil, isDir: true)) }
                continue
            }
            guard seen.insert(path).inserted else { continue }
            entries.append(AssetEntry(path: path, size: item["size"]?.intValue ?? 0, mtime: item["mtime"]?.doubleValue,
                                      isDir: item["is_dir"]?.boolValue ?? false))
        }
        entries.sort { a, b in
            if a.isDir != b.isDir { return a.isDir }
            return a.name.localizedStandardCompare(b.name) == .orderedAscending
        }
        return AssetListing(entries: entries, refreshing: answer["cache"]?["refreshing"]?.boolValue ?? false,
                            retryAfter: answer["cache"]?["retry_after"]?.doubleValue,
                            mounted: answer["storage"]?["mounted"]?.boolValue ?? answer["mounted"]?.boolValue)
    }

    /// The file's bytes (`thumb`: a small preview of an image).
    public func assetData(_ frame: Frame, path: String, thumb: Bool = false) async throws -> Data {
        let (data, _) = try await client.bytes(Self.framePath(frame.id, "/asset"), query: [
            "path": path, "thumb": thumb ? "1" : nil, "mode": thumb ? nil : "image",
        ], timeout: 60)
        return data
    }

    /// Upload into `folder`, in chunks the frame takes one at a time (the
    /// SPA's assetsLogic: 256 KiB on an ESP32, larger on Linux). A chunk the
    /// plane lost (`409 chunk_gap`) restarts the upload once with a new id.
    public func uploadAsset(_ frame: Frame, folder: String, filename: String, data: Data,
                            progress: (@Sendable (Double) -> Void)? = nil) async throws
    {
        let chunkSize = frame.isEmbedded ? 256 * 1024 : (kind == .cloud ? 1024 * 1024 : 512 * 1024)
        var attempt = 0
        while true {
            do {
                try await uploadChunks(path: Self.framePath(frame.id, "/assets/upload"), base: [
                    "filename": filename, "path": folder.isEmpty ? nil : folder,
                ], data: data, chunkSize: chunkSize, idLength: 32, chunkIndex: true, progress: progress)
                return
            } catch let error as APIError where error.status == 409 && attempt == 0 {
                attempt += 1
            }
        }
    }

    /// The chunked upload both planes speak (assets and photos): raw bytes,
    /// `upload_id`, `offset`, `complete`. A failed chunk is retried twice.
    /// Returns the plane's answer to the last chunk (the stored entry).
    @discardableResult
    func uploadChunks(path: String, base: [String: String?], data: Data, chunkSize: Int, idLength: Int,
                      chunkIndex: Bool, progress: (@Sendable (Double) -> Void)?) async throws -> JSONValue
    {
        var last: JSONValue = .null
        let uploadId = String(UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased().prefix(idLength))
        var offset = 0
        var index = 0
        repeat {
            let end = min(offset + chunkSize, data.count)
            let chunk = data.subdata(in: offset..<end)
            var query = base
            query["upload_id"] = uploadId
            query["offset"] = String(offset)
            query["complete"] = end >= data.count ? "1" : "0"
            if chunkIndex { query["chunk_index"] = String(index) }
            var tries = 0
            while true {
                do {
                    last = try await client.call("POST", path, query: query,
                                                 body: .data(chunk, contentType: "application/octet-stream"), timeout: 120)
                    break
                } catch let error as APIError where error.status != 409 && error.status < 500 && error.status != 0 {
                    throw error
                } catch {
                    tries += 1
                    if tries > 2 { throw error }
                }
            }
            offset = end
            index += 1
            progress?(data.isEmpty ? 1 : Double(offset) / Double(data.count))
        } while offset < data.count
        return last
    }

    public func createAssetFolder(_ frame: Frame, path: String) async throws {
        try await client.call("POST", Self.framePath(frame.id, "/assets/mkdir"), body: .form(["path": path]), timeout: 45)
    }

    public func renameAsset(_ frame: Frame, from: String, to: String) async throws {
        try await client.call("POST", Self.framePath(frame.id, "/assets/rename"), body: .form(["src": from, "dst": to]), timeout: 45)
    }

    public func deleteAsset(_ frame: Frame, path: String) async throws {
        try await client.call("POST", Self.framePath(frame.id, "/assets/delete"), body: .form(["path": path]), timeout: 45)
    }
}
