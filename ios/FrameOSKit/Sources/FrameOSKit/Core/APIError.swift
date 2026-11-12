import Foundation

/// What a control plane answered when it said no. Both planes send JSON
/// errors: the cloud `{"error": "<snake_code>", ...}`, the backend FastAPI's
/// `{"detail": "..."}` (or a list of validation errors).
public struct APIError: Error, LocalizedError, Sendable, Equatable {
    public var status: Int
    /// The cloud's error code (`login_required`, `frame_not_active`, ...), or "".
    public var code: String
    /// A sentence a person can read.
    public var message: String
    /// The whole JSON body, when there was one.
    public var body: JSONValue?
    /// Seconds to wait (429 `Retry-After`, or `retry_after` in the body).
    public var retryAfter: Double?

    public init(status: Int, code: String = "", message: String, body: JSONValue? = nil, retryAfter: Double? = nil) {
        self.status = status
        self.code = code
        self.message = message
        self.body = body
        self.retryAfter = retryAfter
    }

    public var errorDescription: String? { message }

    /// Signed out: the session expired or was revoked.
    public var isUnauthorized: Bool { status == 401 }

    /// The cloud's sudo mode: a recent sign-in is needed for this action.
    public var needsReauth: Bool { code == "reauth_required" }

    static func from(status: Int, data: Data, headers: [AnyHashable: Any]) -> APIError {
        let body = try? JSONDecoder().decode(JSONValue.self, from: data)
        var code = body?["error"]?.stringValueIfString ?? ""
        var message = ""
        if let detail = body?["detail"] {
            if let text = detail.stringValueIfString {
                message = text
            } else if let list = detail.arrayValue {
                message = list.compactMap { $0["msg"]?.stringValue }.joined(separator: "; ")
            }
        }
        if message.isEmpty, let text = body?["message"]?.stringValueIfString { message = text }
        if code.isEmpty, status == 401 { code = "login_required" }
        if message.isEmpty, code == "cloud_rendered_frame_quota_exceeded" {
            message = APIError.cloudRenderedQuotaWords(max: body?["max_cloud_rendered_frames"]?.intValue ?? 0)
        }
        if message.isEmpty { message = APIError.words(for: code, status: status) }
        var retryAfter = body?["retry_after"]?.doubleValue
        if retryAfter == nil, let header = headers["Retry-After"] as? String ?? headers["retry-after"] as? String {
            retryAfter = Double(header)
        }
        if message.isEmpty, !code.isEmpty {
            // A code without words of our own: the code, in words.
            let spaced = code.replacingOccurrences(of: "_", with: " ")
            message = spaced.prefix(1).uppercased() + spaced.dropFirst() + "."
        }
        if message.isEmpty, body == nil, let text = String(data: data, encoding: .utf8), !text.isEmpty, text.count < 300,
           !text.hasPrefix("<")
        {
            message = text
        }
        if message.isEmpty { message = HTTPURLResponse.localizedString(forStatusCode: status).capitalized }
        return APIError(status: status, code: code, message: message, body: body, retryAfter: retryAfter)
    }

    /// The plan's cloud-rendered frames are all in use: a virtual frame, or
    /// "Render scenes: On FrameOS Cloud" (the SPA's cloudFrameApi.ts words).
    static func cloudRenderedQuotaWords(max: Int) -> String {
        max > 0
            ? "Your plan renders \(max) frame\(max == 1 ? "" : "s") on FrameOS Cloud, and all of them are in use. Free one up or move to a larger plan."
            : "Your plan has no frames rendered on FrameOS Cloud. A paid plan includes them."
    }

    /// Plain words for the cloud's codes a person meets in the app.
    static func words(for code: String, status: Int) -> String {
        switch code {
        case "login_required": return "You are signed out. Sign in again."
        case "invalid_credentials": return "That email and password do not match."
        case "invalid_code": return "That code is not right. Try the newest one."
        case "sign_in_expired": return "The sign-in took too long. Start again."
        case "invalid_grant": return "That sign-in took too long or was already used. Try again."
        case "link_expired": return "That took too long. Sign in with Apple again."
        case "link_conflict": return "This Apple ID is already connected to another FrameOS Cloud account."
        case "apple_unavailable": return "Sign in with Apple is not set up on this FrameOS Cloud."
        case "invalid_confirmation": return "Type the account's email address exactly as it is."
        case "superadmin_cannot_self_delete": return "An administrator account cannot delete itself. Hand the role over first."
        case "email_unverified": return "Confirm your email address first: we sent you a link."
        case "rate_limited": return "Too many requests. Wait a moment and try again."
        case "frame_not_active": return "This frame is not active."
        case "frame_offline": return "The frame is offline or asleep. Try again when it is back."
        case "frame_unreachable": return "The frame did not answer in time."
        case "frame_update_required": return "This needs a newer FrameOS on the frame."
        case "settings_need_newer_firmware": return "This setting needs a newer FrameOS on the frame."
        case "setting_not_allowed": return "This frame does not take one of these settings."
        case "reauth_required": return "Confirm it is you to do this."
        case "read_only_token": return "This sign-in can only read."
        case "too_many_scenes": return "A frame holds at most 20 scenes."
        case "unsupported_type": return "Only JPEG, PNG, GIF and WebP photos can be uploaded."
        case "storage_quota_exceeded": return "Your photo storage is full."
        case "exists": return "Something with that name is already there."
        case "not_found": return "It is not there any more."
        case "photos_unavailable": return "Photos are not available on this account right now."
        case "ai_disabled": return "AI is turned off for this account."
        case "daily_cap_reached": return "You have used today's AI allowance."
        case "missing_api_key": return "Add an OpenAI key in Settings to use AI."
        case "turn_in_progress": return "The AI is still answering the last message."
        case "invalid_frame": return "That frame is not on this account."
        case "invalid_password": return "That password is not right."
        case "second_factor_required": return "Type the code from your authenticator instead of the password."
        case "interval_below_plan_floor": return "Your plan does not render this often. Choose a longer interval."
        case "settings_not_supported_by_device": return "This frame does not take these settings."
        case "invalid_settings": return "The frame did not take these values. Check them and try again."
        case "scene_name_taken": return "You already have a scene with that name."
        case "too_many_turns": return "The AI is busy with other messages. Try again in a moment."
        case "no_preview": return "The frame shows no preview."
        case "chunk_too_large", "too_large": return "That file is too large."
        default: return ""
        }
    }
}
