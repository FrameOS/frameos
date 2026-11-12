import Foundation

/// The self-hosted backend's MCP server (`POST /api/mcp`, docs/mcp.md), used
/// for the few actions whose work is not one route: installing scenes (fresh
/// ids for every scene and node, references rewritten: the backend's
/// `duplicate_scenes`, the SPA's duplicateScenes.ts) and installing a photo
/// album. Calling the backend's own tool keeps that logic in one place
/// instead of adding a Swift copy of it. The MCP takes the same sign-in as
/// every route. (The cloud's MCP takes API tokens only; the cloud's installs
/// are single routes anyway: `/scenes/add`, `/api/photos/scene`.)
extension APIClient {
    public func mcpTool(_ name: String, arguments: [String: JSONValue]) async throws -> JSONValue {
        let body: JSONValue = [
            "jsonrpc": "2.0",
            "id": .string(UUID().uuidString),
            "method": "tools/call",
            "params": ["name": .string(name), "arguments": .object(arguments)],
        ]
        var request = self.request("POST", "/api/mcp", body: .json(body), timeout: 180)
        request.setValue("application/json, text/event-stream", forHTTPHeaderField: "Accept")
        request.setValue("2025-06-18", forHTTPHeaderField: "MCP-Protocol-Version")
        let (data, _) = try await send(request)
        let answer = try JSONDecoder().decode(JSONValue.self, from: data)
        if let error = answer["error"] {
            throw APIError(status: 0, code: "mcp_error", message: error["message"]?.stringValue ?? "The backend refused it.")
        }
        guard let result = answer["result"] else {
            throw APIError(status: 0, message: "The backend gave no answer.")
        }
        let text = (result["content"]?.arrayValue ?? []).compactMap { item -> String? in
            item["type"]?.stringValue == "text" ? item["text"]?.stringValue : nil
        }.joined(separator: "\n")
        if result["isError"]?.boolValue == true {
            throw APIError(status: 0, code: "mcp_error", message: text.isEmpty ? "The backend refused it." : text)
        }
        if let structured = result["structuredContent"], !structured.isNull { return structured }
        if let parsed = try? JSONDecoder().decode(JSONValue.self, from: Data(text.utf8)) { return parsed }
        return .string(text)
    }
}
