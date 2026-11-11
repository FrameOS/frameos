import Foundation

/// A scene that can be installed on a frame ("Add scene"): a store scene on
/// the cloud, a saved scene or a catalog entry on a backend.
public struct CatalogItem: Identifiable, Hashable, Sendable {
    public enum Source: Hashable, Sendable {
        /// A FrameOS Cloud store scene (public, or the account's own): its uuid.
        case cloudStore(String)
        /// A backend's saved scene (`/api/templates`).
        case backendTemplate(String)
        /// A backend catalog repository entry (its JSON, and the repository's url).
        case backendRepository(template: JSONValue, repositoryURL: String)
    }

    public var id: String
    public var source: Source
    public var name: String
    public var description: String
    public var category: String?
    public var author: String?
    /// An absolute URL, or a path on the plane (needs the account's credentials).
    public var image: String?
    public var flags: [String]
    public var group: String

    /// Store scenes flagged `shell` run commands on the frame (the SPA asks first).
    public var needsShell: Bool { flags.contains("shell") }
}

extension FrameOSService {
    /// One page of the catalog. Cloud: the store's browse (featured first) or
    /// the account's own scenes; backend: saved scenes and every repository.
    public func catalog(query: String = "", page: Int = 1, mine: Bool = false) async throws -> (items: [CatalogItem], hasMore: Bool) {
        switch kind {
        case .cloud:
            if mine {
                let answer = try await client.get("/api/account/scenes", query: ["q": query.isEmpty ? nil : query])
                let items = (answer["scenes"]?.arrayValue ?? []).compactMap { scene -> CatalogItem? in
                    guard let id = scene["id"]?.stringValue, scene["status"]?.stringValue != "pulled" else { return nil }
                    return CatalogItem(
                        id: id, source: .cloudStore(id), name: scene["name"]?.stringValue ?? "Untitled scene",
                        description: scene["description"]?.stringValue ?? "", category: scene["category"]?.stringValue,
                        author: nil,
                        image: scene["has_preview"]?.boolValue == true ? "/api/store/scenes/\(id)/image" : nil,
                        flags: scene["risk_flags"]?.arrayValue?.compactMap(\.stringValue) ?? [],
                        group: scene["visibility"]?.stringValue == "public" ? "My published scenes" : "My scenes"
                    )
                }
                return (items, false)
            }
            let answer = try await client.get("/api/store/browse", query: ["q": query.isEmpty ? nil : query, "page": String(page)])
            let items = (answer["scenes"]?.arrayValue ?? []).compactMap { scene -> CatalogItem? in
                guard let id = scene["id"]?.stringValue else { return nil }
                return CatalogItem(
                    id: id, source: .cloudStore(id), name: scene["name"]?.stringValue ?? "Untitled scene",
                    description: scene["description"]?.stringValue ?? "", category: scene["category"]?.stringValue,
                    author: scene["publisher"]?["name"]?.stringValue ?? scene["publisher"]?.stringValue,
                    image: scene["hasPreview"]?.boolValue == false ? nil : "/api/store/scenes/\(id)/image",
                    flags: scene["riskFlags"]?.arrayValue?.compactMap(\.stringValue) ?? [],
                    group: scene["category"]?.stringValue ?? "Store"
                )
            }
            return (items, answer["hasMore"]?.boolValue ?? false)
        case .backend:
            var items: [CatalogItem] = []
            let needle = query.lowercased()
            func matches(_ name: String, _ description: String) -> Bool {
                needle.isEmpty || name.lowercased().contains(needle) || description.lowercased().contains(needle)
            }
            if let templates = try? await client.get("/api/templates") {
                for template in templates.arrayValue ?? [] {
                    guard let id = template["id"]?.stringValue else { continue }
                    let name = template["name"]?.stringValue ?? "Untitled scene"
                    let description = template["description"]?.stringValue ?? ""
                    guard matches(name, description) else { continue }
                    items.append(CatalogItem(id: "template:\(id)", source: .backendTemplate(id), name: name,
                                             description: description, category: nil, author: nil,
                                             image: template["image"]?.stringValue, flags: [], group: "Saved scenes"))
                }
            }
            let repositories = try await client.get("/api/repositories")
            for repository in repositories.arrayValue ?? [] {
                let repoName = repository["name"]?.stringValue ?? "Repository"
                let repoURL = repository["url"]?.stringValue ?? ""
                for template in repository["templates"]?.arrayValue ?? [] {
                    let name = template["name"]?.stringValue ?? "Untitled scene"
                    let description = template["description"]?.stringValue ?? ""
                    guard matches(name, description) else { continue }
                    let key = template["id"]?.stringValue ?? name
                    items.append(CatalogItem(
                        id: "repo:\(repoURL):\(key)", source: .backendRepository(template: template, repositoryURL: repoURL),
                        name: name, description: description, category: template["category"]?.stringValue,
                        author: template["author"]?.stringValue,
                        image: template["image"]?.stringValue.map { Self.resolveRepositoryURL($0, repoURL) },
                        flags: template["flags"]?.arrayValue?.compactMap(\.stringValue) ?? [], group: repoName
                    ))
                }
            }
            return (items, false)
        }
    }

    /// The account's service-key groups (`/api/settings`, cloud/docs: frames' "Service settings").
    public static let serviceSettingGroups = ["unsplash", "openAI", "homeAssistant", "immich", "github", "frameOS"]

    /// `./x` in a repository index is relative to the index (the SPA's resolveRepositoryUrl).
    static func resolveRepositoryURL(_ value: String, _ repositoryURL: String) -> String {
        guard value.hasPrefix("./"), let base = URL(string: repositoryURL) else { return value }
        return URL(string: String(value.dropFirst(2)), relativeTo: base.deletingLastPathComponent())?.absoluteString ?? value
    }

    /// Install a catalog scene on a frame, and show it when `activate`.
    /// Cloud: `POST …/scenes/add` (one push). Backend: the backend's own
    /// `frame_scene_install` (fresh ids, saved, fast deploy).
    public func install(_ item: CatalogItem, on frame: Frame, activate: Bool, grantSettings: [String]? = nil) async throws -> ActionOutcome {
        switch item.source {
        case .cloudStore(let storeId):
            // Installing is the owner's consent (the SPA's templatesLogic): the
            // scene gets the API keys it declares. The route grants only what
            // the scene declares (`settings_groups` ∩ declared), so naming
            // every group grants exactly that.
            let groups = grantSettings ?? Self.serviceSettingGroups
            let body: [String: JSONValue] = [
                "scene_id": .string(storeId), "activate": .bool(activate),
                "settings_groups": .array(groups.map { .string($0) }),
            ]
            let answer = try await client.call("POST", Self.framePath(frame.id, "/scenes/add"), body: .json(.object(body)))
            let declared = answer["declared_settings_groups"]?.arrayValue?.compactMap(\.stringValue) ?? []
            let granted = answer["granted_settings_groups"]?.arrayValue?.compactMap(\.stringValue) ?? []
            let missing = declared.filter { !granted.contains($0) }
            var message = activate ? "Installed. The frame shows it when it next checks in." : "Installed and pushed."
            if !missing.isEmpty {
                message += " It asks for these API keys, which it was not given: \(missing.joined(separator: ", "))."
            }
            return ActionOutcome(kind: .queued, message: message)
        case .backendTemplate(let templateId):
            return try await backendInstall(frame, ["template_id": .string(templateId)], activate: activate)
        case .backendRepository(let template, let repositoryURL):
            if let scenes = template["scenes"], let list = scenes.arrayValue, !list.isEmpty {
                return try await backendInstall(frame, ["scenes": scenes, "name": .string(item.name)], activate: activate)
            }
            if let scenesURL = template["scenesUrl"]?.stringValue, !scenesURL.isEmpty {
                let resolved = Self.resolveRepositoryURL(scenesURL, repositoryURL)
                let scenes: JSONValue
                if resolved.hasPrefix("http://") || resolved.hasPrefix("https://") {
                    // A public catalog (the cloud store's scenes.json): fetched as it is.
                    let (data, response) = try await URLSession.shared.data(from: URL(string: resolved)!)
                    guard (response as? HTTPURLResponse).map({ (200..<300).contains($0.statusCode) }) ?? false else {
                        throw APIError(status: (response as? HTTPURLResponse)?.statusCode ?? 0, message: "The catalog did not hand out the scene.")
                    }
                    scenes = try JSONDecoder().decode(JSONValue.self, from: data)
                } else {
                    scenes = try await client.get(resolved)
                }
                return try await backendInstall(frame, ["scenes": scenes, "name": .string(item.name)], activate: activate)
            }
            if let zip = template["zip"]?.stringValue, !zip.isEmpty {
                // The backend fetches the zip itself (SSRF-guarded) and reads it.
                let scenes = try await client.call("POST", "/api/templates", body: .json([
                    "format": "scenes", "url": .string(Self.resolveRepositoryURL(zip, repositoryURL)),
                ]))
                return try await backendInstall(frame, ["scenes": scenes, "name": .string(item.name)], activate: activate)
            }
            throw APIError(status: 0, message: "This catalog entry has no scenes to install.")
        }
    }

    func backendInstall(_ frame: Frame, _ source: [String: JSONValue], activate: Bool) async throws -> ActionOutcome {
        var arguments = source
        // As on the cloud: a store scene is granted the keys it declares
        // (the tool grants only what the scenes declare among these).
        arguments["settings_groups"] = .array(Self.serviceSettingGroups.map { .string($0) })
        arguments["confirm"] = true
        arguments["frame_id"] = .number(Double(Int(frame.id) ?? 0))
        arguments["activate"] = .bool(activate)
        arguments["deploy"] = "fast"
        if let projectId = account.projectId { arguments["project_id"] = .number(Double(projectId)) }
        if let scenes = arguments["scenes"], scenes.arrayValue?.count != 1 { arguments["name"] = nil }
        _ = try await client.mcpTool("frame_scene_install", arguments: arguments)
        return ActionOutcome(kind: .done, message: activate ? "Installed. The frame shows it after the deploy." : "Installed and deploying.")
    }
}
