import XCTest

/// The whole app against a real control plane: sign in, a frame, installing
/// a scene, every page of the frame, every tab. Each step keeps a
/// screenshot in the result bundle (ios/bin/ui-test copies them out).
///
/// - Backend: `FRAMEOS_UITEST_BACKEND` (ios/bin/test-backend starts one with
///   a user and virtual frames).
/// - Cloud: `FRAMEOS_UITEST_CLOUD` plus `FRAMEOS_UITEST_CLOUD_EMAIL` and
///   `FRAMEOS_UITEST_CLOUD_PASSWORD`: a cloud you may write to (a local dev
///   server), an account with a frame and no two-factor sign-in.
///
/// Skipped when not named.
final class TourUITests: XCTestCase {
    var environment: [String: String] { ProcessInfo.processInfo.environment }
    func value(_ key: String, _ fallback: String = "") -> String {
        let found = environment[key] ?? ""
        return found.isEmpty ? fallback : found
    }

    override func setUp() {
        continueAfterFailure = false
    }

    @MainActor
    func testBackendTour() throws {
        let backend = value("FRAMEOS_UITEST_BACKEND")
        try XCTSkipIf(backend.isEmpty, "FRAMEOS_UITEST_BACKEND is not set (ios/bin/ui-test with ios/bin/test-backend)")
        let app = launchClean()
        waitForText(app, "Control your frames")
        let backendButton = button(app, containing: "Sign in to a self-hosted backend")
        while !backendButton.isHittable { app.swipeUp() }
        backendButton.tap()
        type(app.textFields["frameos.local:8989"], backend)
        type(app.textFields["Email"], value("FRAMEOS_UITEST_EMAIL", "tester@example.com"))
        type(app.secureTextFields["Password"], value("FRAMEOS_UITEST_PASSWORD", "frameos-test-1"))
        snapshot(app, "b10 sign in")
        app.buttons["Sign in"].tap()
        tour(app, prefix: "b", frame: value("FRAMEOS_UITEST_FRAME", "Kitchen"),
             scene: value("FRAMEOS_UITEST_SCENE", "Analog clock face"))
    }

    @MainActor
    func testCloudTour() throws {
        let cloud = value("FRAMEOS_UITEST_CLOUD")
        try XCTSkipIf(cloud.isEmpty, "FRAMEOS_UITEST_CLOUD is not set")
        let app = launchClean()
        waitForText(app, "Control your frames")
        let other = button(app, containing: "Use another cloud address")
        while !other.isHittable { app.swipeUp() }
        other.tap()
        let address = app.textFields["Cloud address"]
        XCTAssertTrue(address.waitForExistence(timeout: 5))
        address.tap()
        address.press(forDuration: 1.2)
        if app.menuItems["Select All"].waitForExistence(timeout: 2) { app.menuItems["Select All"].tap() }
        address.typeText(cloud)
        type(app.textFields["Email"], value("FRAMEOS_UITEST_CLOUD_EMAIL"))
        type(app.secureTextFields["Password"], value("FRAMEOS_UITEST_CLOUD_PASSWORD"))
        snapshot(app, "c10 sign in")
        app.buttons["Sign in"].tap()
        tour(app, prefix: "c", frame: value("FRAMEOS_UITEST_FRAME", "Kitchen"),
             scene: value("FRAMEOS_UITEST_CLOUD_SCENE", "Word clock"))
    }

    @MainActor
    func tour(_ app: XCUIApplication, prefix: String, frame: String, scene: String) {
        // The frames.
        XCTAssertTrue(app.navigationBars["Frames"].waitForExistence(timeout: 30), "the frames list did not open")
        waitForText(app, frame)
        sleep(3) // the pictures
        snapshot(app, "\(prefix)11 frames")

        // One frame.
        button(app, containing: frame).tap()
        waitForText(app, "Add scene")
        sleep(2)
        snapshot(app, "\(prefix)12 frame")

        // A scene from the catalog, installed and shown.
        if !button(app, containing: scene).exists {
            let add = button(app, containing: "Add scene")
            while !add.isHittable { app.swipeUp() }
            add.tap()
            waitForText(app, scene, timeout: 40)
            sleep(2)
            snapshot(app, "\(prefix)13 add scene")
            button(app, containing: scene).tap()
            let install = button(app, containing: "Install & activate")
            XCTAssertTrue(install.waitForExistence(timeout: 10))
            snapshot(app, "\(prefix)14 install")
            install.tap()
            XCTAssertTrue(app.navigationBars.buttons["More"].waitForExistence(timeout: 120) || button(app, containing: "Add scene").waitForExistence(timeout: 5),
                          "the install did not come back to the frame")
            waitForText(app, scene, timeout: 60)
        }
        sleep(8) // the frame renders it
        app.swipeDown()
        sleep(4)
        snapshot(app, "\(prefix)15 frame with scene")

        // The scene's own sheet.
        let row = button(app, containing: scene)
        while !row.isHittable { app.swipeUp() }
        row.tap()
        XCTAssertTrue(app.buttons["Done"].waitForExistence(timeout: 15), "the scene did not open")
        sleep(2)
        snapshot(app, "\(prefix)16 scene")
        app.swipeUp()
        snapshot(app, "\(prefix)17 scene, lower")
        app.buttons["Done"].tap()

        // Every page linked from the frame, then back.
        let pages = [
            ("Settings", "20 frame settings"), ("Schedule", "21 schedule"), ("Button actions", "22 button actions"),
            ("Assets", "23 assets"), ("Logs", "24 logs"), ("Metrics", "25 metrics"),
            ("Ask AI about this frame", "26 frame chat"),
        ]
        for (title, shot) in pages {
            let link = button(app, containing: title)
            var tries = 0
            while !link.isHittable && tries < 8 { app.swipeUp(); tries += 1 }
            guard link.isHittable else {
                snapshot(app, "\(prefix)\(shot) missing")
                XCTFail("no \(title) on the frame page")
                continue
            }
            link.tap()
            sleep(3)
            snapshot(app, "\(prefix)\(shot)")
            app.navigationBars.buttons.element(boundBy: 0).tap()
            sleep(1)
        }

        // The other tabs.
        for (tab, shot) in [("Scenes", "30 scenes"), ("Photos", "31 photos"), ("AI", "32 ai"), ("Settings", "33 settings")] {
            app.tabBars.buttons[tab].tap()
            sleep(3)
            snapshot(app, "\(prefix)\(shot)")
        }
        app.tabBars.buttons["Frames"].tap()
    }
}
