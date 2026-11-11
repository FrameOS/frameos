import XCTest

/// The sign-in screen, with no server: the cloud first, the self-hosted
/// backend below it. These run on every CI build.
final class SignInUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    @MainActor
    func testCloudFirstThenBackendBelow() {
        let app = launchClean()
        waitForText(app, "Control your frames, scenes and photos.")
        XCTAssertTrue(app.textFields["Email"].exists)
        XCTAssertTrue(app.secureTextFields["Password"].exists)
        XCTAssertFalse(app.buttons["Sign in"].isEnabled, "nothing typed: nothing to sign in with")
        snapshot(app, "01 sign in")

        let backend = button(app, containing: "Sign in to a self-hosted backend")
        while !backend.isHittable { app.swipeUp() }
        backend.tap()
        waitForText(app, "Sign in to the FrameOS backend you run yourself.")
        XCTAssertTrue(app.textFields["frameos.local:8989"].exists)
        snapshot(app, "02 backend sign in")

        let cloud = button(app, containing: "Sign in to FrameOS Cloud instead")
        while !cloud.isHittable { app.swipeUp() }
        cloud.tap()
        waitForText(app, "Control your frames, scenes and photos.")
    }

    /// A backend address nothing answers at says so, in words.
    @MainActor
    func testBackendThatDoesNotAnswer() {
        let app = launchClean()
        let backend = button(app, containing: "Sign in to a self-hosted backend")
        waitForText(app, "Control your frames")
        while !backend.isHittable { app.swipeUp() }
        backend.tap()
        type(app.textFields["frameos.local:8989"], "127.0.0.1:9")
        type(app.textFields["Email"], "someone@example.com")
        type(app.secureTextFields["Password"], "not-a-real-password")
        app.buttons["Sign in"].tap()
        waitForText(app, "Cannot reach that backend", timeout: 30)
        snapshot(app, "03 backend unreachable")
    }
}
