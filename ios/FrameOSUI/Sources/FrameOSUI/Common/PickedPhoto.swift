import Foundation
import ImageIO
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// A photo picked from the library, as bytes both planes accept.
///
/// The library stores uploads byte for byte and reads their metadata
/// ("inform, don't punish", docs/photos.md): the picker hands over the
/// original when it is JPEG, PNG, GIF or WebP, and a JPEG the system made
/// (metadata kept) for HEIC and other formats the planes refuse.
struct PickedPhoto {
    let data: Data
    let filename: String

    static let accepted: Set<String> = [UTType.jpeg.identifier, UTType.png.identifier, UTType.gif.identifier, UTType.webP.identifier]

    static func load(_ item: PhotosPickerItem) async -> PickedPhoto? {
        guard let data = try? await item.loadTransferable(type: Data.self) else { return nil }
        // The picker names no file: a time stamp keeps uploads apart (a taken
        // name would come back as "name (2).jpg" anyway).
        let stamp = Self.timestamp()
        guard let source = CGImageSourceCreateWithData(data as CFData, nil), let type = CGImageSourceGetType(source) as String? else {
            return PickedPhoto(data: data, filename: "\(stamp).jpg")
        }
        if accepted.contains(type) {
            let ext = UTType(type)?.preferredFilenameExtension ?? "jpg"
            return PickedPhoto(data: data, filename: "\(stamp).\(ext)")
        }
        // HEIC and friends: the same picture as JPEG, its metadata copied over.
        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(output, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImageFromSource(destination, source, 0, [kCGImageDestinationLossyCompressionQuality: 0.92] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return PickedPhoto(data: output as Data, filename: "\(stamp).jpg")
    }

    static func timestamp() -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyyMMdd-HHmmss-SSS"
        formatter.locale = Locale(identifier: "en_US_POSIX")
        return "IMG-" + formatter.string(from: Date())
    }
}
