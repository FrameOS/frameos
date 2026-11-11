import Foundation

/// The two control planes a frame can belong to: FrameOS Cloud and a
/// self-hosted backend. The app speaks to both through the same canonical
/// `/api/...` routes the shared SPA calls (docs/api-triality.md); what
/// differs per plane is decided in one place, `APIClient.resolve`, the way
/// the SPA keeps it in frontend/src/utils/apiFetch.ts.
public enum PlaneKind: String, Codable, Sendable, CaseIterable {
    case cloud
    case backend

    public var title: String {
        switch self {
        case .cloud: return "FrameOS Cloud"
        case .backend: return "Self-hosted backend"
        }
    }
}
