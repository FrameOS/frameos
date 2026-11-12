import Foundation
import Testing
@testable import FrameOSKit

/// The iOS runner of docs/api-path-fixtures.json, and the URLs the client builds.
@Suite struct ApiPathTests {
    @Test func projectScopingMatchesTheSPA() throws {
        let fixtures = try RepoFixtures.json("docs/api-path-fixtures.json")
        let cases = try #require(fixtures["cases"]?.arrayValue)
        #expect(cases.count > 20)
        for kase in cases {
            let path = kase["path"]?.stringValue ?? ""
            #expect(ApiPaths.isProjectScoped(path) == kase["scoped"]?.boolValue, "\(path)")
        }
    }

    @Test func backendURLsAreScoped() {
        let account = Account(kind: .backend, baseURL: URL(string: "http://frames.local:8989")!, email: "a@b.c", projectId: 3)
        let client = APIClient(account: account, credentials: AccountCredentials())
        #expect(client.url("/api/frames/7/event/render").absoluteString == "http://frames.local:8989/api/projects/3/frames/7/event/render")
        #expect(client.url("/api/login").absoluteString == "http://frames.local:8989/api/login")
        #expect(client.url("/api/photos/files", query: ["path": "Trips/Rome & Pisa"]).absoluteString
            == "http://frames.local:8989/api/projects/3/photos/files?path=Trips/Rome%20%26%20Pisa")
        #expect(client.url("/api/frames/7/scene_images/system/index", query: ["thumb": "1"]).absoluteString
            == "http://frames.local:8989/api/projects/3/frames/7/scene_images/system/index?thumb=1")
    }

    @Test func cloudURLsAreAsWritten() {
        let account = Account(kind: .cloud, baseURL: Account.defaultCloudURL, email: "a@b.c")
        let client = APIClient(account: account, credentials: AccountCredentials())
        #expect(client.url("/api/frames").absoluteString == "https://cloud.frameos.net/api/frames")
        #expect(client.url("/api/store/browse", query: ["q": "a+b"]).absoluteString == "https://cloud.frameos.net/api/store/browse?q=a%2Bb")
        var request = client.request("POST", "/api/frames/x/event/render", body: .json([:]))
        #expect(request.value(forHTTPHeaderField: "Origin") == "https://cloud.frameos.net")
        #expect(request.value(forHTTPHeaderField: "Content-Type") == "application/json")
        request = client.request("GET", "/api/frames")
        #expect(request.value(forHTTPHeaderField: "Authorization") == nil)
    }

    @Test func backendRequestsCarryTheBearer() {
        let account = Account(kind: .backend, baseURL: URL(string: "https://frames.example.com")!, email: "a@b.c", projectId: 1)
        let client = APIClient(account: account, credentials: AccountCredentials(bearer: "fb_api_x"))
        let request = client.request("POST", "/api/frames/1/assets/mkdir", body: .form(["path": "a b/c"]))
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer fb_api_x")
        #expect(request.value(forHTTPHeaderField: "Origin") == nil)
        #expect(String(decoding: request.httpBody ?? Data(), as: UTF8.self) == "path=a%20b%2Fc")
    }
}
