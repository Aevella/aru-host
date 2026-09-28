import Foundation
import Testing
@testable import AruHostConsole

@Suite struct HostCoreInstallerTests {
    @Test func semanticUpdateOrderDoesNotDowngradePrereleases() {
        #expect(HostSemanticVersion.isNewer("0.33.0-rc.10", than: "0.33.0-rc.2"))
        #expect(!HostSemanticVersion.isNewer("0.33.0-rc.2", than: "0.33.0-rc.10"))
        #expect(!HostSemanticVersion.isNewer("0.33.0+new", than: "0.33.0+old"))
        #expect(!HostSemanticVersion.isNewer("0.33.0", than: "unknown"))
    }

    @Test(arguments: ["0.33.0", "0.34.0", "", "0.32.0"])
    func independentInstallIsNeverReplaced(version: String) async throws {
        let f = try Fixture(owner: "independent", version: version)
        defer { f.remove() }
        let result = try await f.installer.prepare()
        #expect(result.owner == .independent)
        #expect(result.updateVersion == nil)
        let commands = await f.commands.values
        #expect(!commands.contains { $0.contains("--source-dir") })
        #expect(commands.contains { $0.last == f.instance.root.appending(path: "current/server.mjs").path })
        #expect(commands.contains { $0.first == "kickstart" && !$0.contains("-k") })
        // The global CLI wrapper is absent; the desktop can still connect/pair.
        #expect(f.instance.controlTool.path.contains("instances/default/current/aru-selfhost"))
    }

    @Test(arguments: ["0.32.0", "0.33.0", "0.34.0", ""])
    func managedUpdatesAreExplicitAndNeverDowngrade(version: String) async throws {
        let f = try Fixture(owner: "desktop", version: version)
        defer { f.remove() }
        let result = try await f.installer.prepare()
        #expect(result.updateVersion == (version == "0.32.0" ? "0.33.0" : nil))
        #expect(await f.commands.values.allSatisfy { !$0.contains("--source-dir") })
        if result.updateVersion != nil {
            try await f.installer.update(expected: result)
            #expect(await f.commands.values.filter { $0.contains("--source-dir") }.count == 1)
        }
    }

    @Test func firstInstallRecordsDesktopOwnership() async throws {
        let f = try Fixture(owner: nil, version: "", installed: false)
        defer { f.remove() }
        let result = try await f.installer.prepare()
        #expect(result.owner == .desktop)
        #expect(result.installedVersion == "0.33.0")
        let command = try #require(await f.commands.values.first)
        #expect(command.contains("--install-owner"))
        #expect(command.last == "desktop")
    }

    @Test func missingIndependentProgramDoesNotAuthorizeRepair() async throws {
        let f = try Fixture(owner: "independent", version: "0.33.0")
        defer { f.remove() }
        try FileManager.default.removeItem(at: f.instance.root.appending(path: "current/server.mjs"))
        await #expect(throws: HostCoreInstallationError.independentRepair) { try await f.installer.prepare() }
        #expect(await f.commands.values.isEmpty)
    }

    @Test func managedMissingProgramCanBeRepairedWithoutDowngrade() async throws {
        let f = try Fixture(owner: "desktop", version: "0.33.0")
        defer { f.remove() }
        try FileManager.default.removeItem(at: f.instance.root.appending(path: "current/server.mjs"))
        let prepared = try await f.installer.prepare()
        #expect(prepared.operation == .repair)
        #expect(await f.commands.values.isEmpty)
        try await f.installer.update(expected: prepared)
        #expect(await f.commands.values.contains { $0.contains("--source-dir") })
    }

    @Test func changedOwnershipInvalidatesUpdate() async throws {
        let f = try Fixture(owner: "desktop", version: "0.32.0")
        defer { f.remove() }
        let result = try await f.installer.prepare()
        try "ARU_INSTALL_OWNER=independent\nARU_INSTALL_RELEASE_VERSION=0.32.0\n".write(
            to: f.instance.root.appending(path: "config/install.env"), atomically: true, encoding: .utf8)
        await #expect(throws: HostCoreInstallationError.managedRepair) { try await f.installer.update(expected: result) }
        #expect(await f.commands.values.allSatisfy { !$0.contains("--source-dir") })
    }

    @Test func selectingAnotherInstanceInvalidatesPreparedUpdate() async throws {
        let f = try Fixture(owner: "desktop", version: "0.32.0")
        defer { f.remove() }
        let expected = try await f.installer.prepare()
        let other = f.instance.baseRoot.appending(path: "instances/home/config")
        try FileManager.default.createDirectory(at: other, withIntermediateDirectories: true)
        try "ARU_INSTALL_OWNER=desktop\nARU_INSTALL_RELEASE_VERSION=0.32.0\n".write(
            to: other.appending(path: "install.env"), atomically: true, encoding: .utf8)
        try LocalHostInstance.select("home", homeDirectory: f.home)
        await #expect(throws: HostCoreInstallationError.managedRepair) {
            try await f.installer.update(expected: expected)
        }
        #expect(await f.commands.values.allSatisfy { !$0.contains("--source-dir") })
    }

    @Test func legacyOwnershipIsMigratedFromProvenanceNotInstanceName() throws {
        let f = try Fixture(owner: nil, version: "0.32.0")
        defer { f.remove() }
        let url = f.instance.root.appending(path: "config/install.env")
        let old = "ARU_INSTALL_SOURCE_DIR=/Applications/Aru\\ Host.app/Contents/Resources/HostCore\n"
        let record = HostCoreInstallationRecord(contents: old)
        #expect(record.owner == .desktop)
        try record.persistLegacyOwner(at: url)
        #expect(try HostCoreInstallationRecord.read(at: url)?.value("ARU_INSTALL_OWNER") == "desktop")
        #expect(HostCoreInstallationRecord(contents: "ARU_INSTALL_INSTANCE=home\n").owner == .independent)
    }
}

private actor Commands {
    var values: [[String]] = []
    func append(_ args: [String]) { values.append(args) }
}

private struct Fixture {
    let home: URL
    let resources: URL
    let instance: LocalHostInstance
    let commands = Commands()
    var installer: BundledHostCoreInstaller {
        let commands = commands
        return BundledHostCoreInstaller(resourceRoot: resources, homeDirectory: home,
            run: { _, args in await commands.append(args) })
    }
    init(owner: String?, version: String, installed: Bool = true) throws {
        home = FileManager.default.temporaryDirectory.appending(path: "host ownership \(UUID().uuidString)")
        resources = home.appending(path: "App Resources")
        instance = LocalHostInstance(homeDirectory: home)
        let payload = resources.appending(path: "HostCore")
        try FileManager.default.createDirectory(at: payload, withIntermediateDirectories: true)
        try #"{"schema":"aru.host.release.v1","version":"0.33.0"}"#.write(
            to: payload.appending(path: "release.json"), atomically: true, encoding: .utf8)
        FileManager.default.createFile(atPath: payload.appending(path: "install-macos.sh").path,
            contents: Data(), attributes: [.posixPermissions: 0o755])
        if installed {
            try FileManager.default.createDirectory(at: instance.root.appending(path: "config"), withIntermediateDirectories: true)
            try FileManager.default.createDirectory(at: instance.root.appending(path: "current"), withIntermediateDirectories: true)
            try ((owner.map { "ARU_INSTALL_OWNER=\($0)\n" } ?? "") + "ARU_INSTALL_RELEASE_VERSION=\(version)\n").write(
                to: instance.root.appending(path: "config/install.env"), atomically: true, encoding: .utf8)
            try "".write(to: instance.root.appending(path: "config/node.env"), atomically: true, encoding: .utf8)
            try "".write(to: instance.root.appending(path: "current/server.mjs"), atomically: true, encoding: .utf8)
        }
    }
    func remove() { try? FileManager.default.removeItem(at: home) }
}
