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
            XCTAssertTrue(app.navigationBars["Add scene"].waitForExistence(timeout: 15))
            sleep(3)
            snapshot(app, "\(prefix)13 add scene")
            // A list makes only the rows on screen: search, as a person would.
            let search = app.searchFields.firstMatch
            XCTAssertTrue(search.waitForExistence(timeout: 10))
            search.tap()
            search.typeText(scene)
            waitForText(app, scene, timeout: 40)
            sleep(2)
            snapshot(app, "\(prefix)13b search")
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
            // In the frame's list, not the tab bar (which has a Settings too).
            let link = app.collectionViews.buttons.matching(NSPredicate(format: "label CONTAINS %@", title)).firstMatch
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
        for (name, shot) in [("Scenes", "30 scenes"), ("Photos", "31 photos"), ("AI", "32 ai"), ("Settings", "33 settings")] {
            tab(app, name).tap()
            sleep(3)
            snapshot(app, "\(prefix)\(shot)")
        }
        photos(app, prefix: prefix, frame: frame)
        tab(app, "Frames").tap()
    }

    /// An album: made, a photo uploaded through the system picker (ios/bin/ui-test
    /// adds one with a location to the simulator), its info, then played on a frame.
    @MainActor
    func photos(_ app: XCUIApplication, prefix: String, frame: String) {
        let album = "Tour \(Int(Date().timeIntervalSince1970) % 100_000)"
        tab(app, "Photos").tap()
        app.navigationBars.buttons["Add"].tap()
        button(app, containing: "New album").tap()
        let name = app.alerts.textFields.firstMatch
        XCTAssertTrue(name.waitForExistence(timeout: 5))
        name.typeText(album)
        app.alerts.buttons["Create"].tap()
        let albumCell = button(app, containing: album)
        XCTAssertTrue(albumCell.waitForExistence(timeout: 15), "the album did not show")
        // New albums go last; a lazy grid says "hittable" for a cell under the tab bar.
        app.swipeUp()
        app.swipeUp()
        albumCell.tap()
        XCTAssertTrue(app.navigationBars[album].waitForExistence(timeout: 10))

        // The system picker runs in its own process; its grid is the app's to tap.
        app.navigationBars.buttons["Add"].tap()
        button(app, containing: "Add photos").tap()
        // The picker's cells read "Photo, <date>" (the tab bar's "Photos" has no comma).
        let picked = app.images.matching(NSPredicate(format: "label BEGINSWITH 'Photo,'")).firstMatch
        let pickerShown = picked.waitForExistence(timeout: 20)
        sleep(1)
        snapshot(app, "\(prefix)40 photo picker")
        if pickerShown {
            picked.tap()
            // The picker's confirm button ("Done"), not the album's own Add behind it.
            let done = app.buttons.matching(NSPredicate(format: "identifier == 'Add' AND label == 'Done'")).firstMatch
            if done.waitForExistence(timeout: 5) { done.tap() }
            sleep(6) // the upload
        } else {
            XCTFail("no photo in the picker")
            app.buttons["Cancel"].firstMatch.tap()
        }
        snapshot(app, "\(prefix)41 album")

        // One photo: the viewer, then its info (the location the upload kept).
        let photo = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] '.jp'")).firstMatch
        if photo.waitForExistence(timeout: 10) {
            XCTAssertEqual(photo.value as? String, "has a location", "the location pin is not told")
            photo.tap()
            sleep(2)
            snapshot(app, "\(prefix)42 photo")
            if app.buttons["Info"].waitForExistence(timeout: 5) {
                app.buttons["Info"].tap()
                sleep(2)
                snapshot(app, "\(prefix)43 photo info")
                app.buttons["Done"].firstMatch.tap()
                sleep(1)
            }
            app.buttons["Done"].firstMatch.tap()
            sleep(1)
        } else {
            XCTFail("the uploaded photo did not show")
        }

        // Play the album on the frame.
        app.navigationBars.buttons["Add"].tap()
        button(app, containing: "Play on a frame").tap()
        XCTAssertTrue(app.navigationBars["Play \(album)"].waitForExistence(timeout: 10))
        // The sheet's own Frame picker (the tab bar has a "Frames").
        let picker = app.collectionViews.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Frame'")).firstMatch
        XCTAssertTrue(picker.waitForExistence(timeout: 5), "no frame picker")
        picker.tap()
        let choice = app.buttons.matching(NSPredicate(format: "label == %@", frame)).firstMatch
        let menuChoice = app.menuItems[frame].firstMatch
        if menuChoice.waitForExistence(timeout: 3) { menuChoice.tap() } else if choice.waitForExistence(timeout: 3) { choice.tap() }
        sleep(1)
        snapshot(app, "\(prefix)44 play album")
        let play = button(app, containing: "Play on frame")
        XCTAssertTrue(play.isEnabled, "no frame chosen")
        play.tap()
        // The sheet closes when the frame has it (the cloud saves a scene first).
        let sheet = app.navigationBars["Play \(album)"]
        let closed = NSPredicate(format: "exists == false")
        XCTAssertEqual(XCTWaiter().wait(for: [expectation(for: closed, evaluatedWith: sheet)], timeout: 150), .completed,
                       "the album was not played")
        sleep(2)
        snapshot(app, "\(prefix)45 album played")
        app.navigationBars.buttons.element(boundBy: 0).tap()

        // The frame, showing the photo the phone uploaded.
        tab(app, "Frames").tap()
        sleep(20) // the frame renders the album
        app.swipeDown()
        sleep(5)
        snapshot(app, "\(prefix)46 frame with album")
    }
}
