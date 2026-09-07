import Foundation
import Testing
@testable import AruHostConsole

@Test func packagedResourcesDoNotEvaluateSwiftPMFallback() throws {
    let root = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let contents = root.appending(path: "Probe.app/Contents")
    let resources = contents.appending(path: "Resources/AruHostConsole_AruHostConsole.bundle")
    try FileManager.default.createDirectory(at: resources, withIntermediateDirectories: true)
    let info = try PropertyListSerialization.data(
        fromPropertyList: ["CFBundleIdentifier": "test.aru.resources", "CFBundlePackageType": "APPL"],
        format: .xml, options: 0)
    try info.write(to: contents.appending(path: "Info.plist"))
    let app = try #require(Bundle(url: root.appending(path: "Probe.app")))
    func unavailableBuildDirectory() -> Bundle {
        Issue.record("A distributed app must not evaluate Bundle.module")
        return .main
    }
    let resolved = HostConsoleResources.resolve(in: app, packageBundle: unavailableBuildDirectory())
    #expect(resolved.bundleURL.standardizedFileURL == resources.standardizedFileURL)
}

@Test func unpackagedResourcesUseSwiftPMFallback() throws {
    let root = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString + ".bundle")
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let empty = try #require(Bundle(url: root))
    #expect(HostConsoleResources.resolve(in: empty, packageBundle: .main) == .main)
}
