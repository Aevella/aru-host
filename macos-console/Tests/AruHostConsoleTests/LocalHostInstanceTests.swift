import Foundation
import Testing
@testable import AruHostConsole

struct LocalHostInstanceTests {
    @Test(arguments: [false, true], [false, true])
    func selectsExistingIdentity(hasHome: Bool, hasDefault: Bool) throws {
        let home = FileManager.default.temporaryDirectory.appending(path: "host instance \(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: home) }
        for (name, installed) in [("home", hasHome), ("default", hasDefault)] where installed {
            let config = home.appending(path: "Library/Application Support/Aru Self-Hosted/instances/\(name)/config")
            try FileManager.default.createDirectory(at: config, withIntermediateDirectories: true)
            try "ARU_INSTALL_RELEASE_VERSION=0.33.0\n".write(
                to: config.appending(path: "install.env"), atomically: true, encoding: .utf8)
        }
        if hasHome && hasDefault {
            #expect(throws: HostCoreInstallationError.chooseInstance(["default", "home"])) {
                try LocalHostInstance.resolve(homeDirectory: home)
            }
            try LocalHostInstance.select("home", homeDirectory: home)
        }
        let instance = try LocalHostInstance.resolve(homeDirectory: home)
        #expect(instance.name == (hasHome ? "home" : "default"))
        #expect(instance.root.lastPathComponent == instance.name)
        #expect(instance.launchLabel == "cn.aelion.aru-selfhost.\(instance.name)")
        #expect(LocalHostInstance(homeDirectory: home).name == instance.name)
    }
    @Test func preservesPartialDesktopInstallation() throws {
        let home = FileManager.default.temporaryDirectory.appending(path: "host partial \(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: home) }
        let data = home.appending(path: "Library/Application Support/Aru Self-Hosted/instances/home/data")
        try FileManager.default.createDirectory(at: data, withIntermediateDirectories: true)
        #expect(LocalHostInstance(homeDirectory: home).name == "home")
    }
    @Test func retainedDataDoesNotHideInstalledTerminalInstance() throws {
        let home = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: home) }
        let base = home.appending(path: "Library/Application Support/Aru Self-Hosted/instances")
        try FileManager.default.createDirectory(at: base.appending(path: "home/data"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: base.appending(path: "default/config"), withIntermediateDirectories: true)
        try "ARU_INSTALL_OWNER=independent".write(to: base.appending(path: "default/config/install.env"), atomically: true, encoding: .utf8)
        #expect(try LocalHostInstance.resolve(homeDirectory: home).name == "default")
    }

}
