import Darwin
import Foundation

protocol HostCoreInstalling: Sendable {
    func prepare() async throws -> HostCorePreparation
    func update(expected: HostCorePreparation) async throws
}

struct BundledHostCoreInstaller: HostCoreInstalling {
    private struct BundledRelease: Decodable {
        let schema: String
        let version: String
    }

    private let resourceRoot: URL?
    private let homeDirectory: URL
    private let run: @Sendable (URL, [String]) async throws -> Void

    init(resourceRoot: URL? = Bundle.main.resourceURL,
         homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser,
         run: @escaping @Sendable (URL, [String]) async throws -> Void = HostCoreCommand.run) {
        self.resourceRoot = resourceRoot
        self.homeDirectory = homeDirectory
        self.run = run
    }

    func prepare() async throws -> HostCorePreparation {
        let instance = try LocalHostInstance.resolve(homeDirectory: homeDirectory)
        let recordURL = instance.root.appending(path: "config/install.env")
        let record = try HostCoreInstallationRecord.read(at: recordURL)
        let owner = record?.owner ?? (instance.hasInstallation ? .independent : .desktop)
        try record?.persistLegacyOwner(at: recordURL)
        let server = instance.root.appending(path: "current/server.mjs")
        let hasProgram = FileManager.default.fileExists(atPath: server.path)
        if !hasProgram {
            guard owner == .desktop else { throw HostCoreInstallationError.independentRepair }
            let payload = try payloadDirectory()
            let release = try Self.readRelease(from: payload)
            if let record {
                guard let version = record.version,
                      version == release.version || HostSemanticVersion.isNewer(release.version, than: version) else {
                    throw HostCoreInstallationError.managedRepair
                }
                // A process can still be serving from memory after files were
                // removed. Repair therefore requires an explicit restart too.
                try instance.rememberSelection()
                return HostCorePreparation(instance: instance.name, owner: .desktop,
                    installedVersion: record.version, updateVersion: release.version, operation: .repair)
            }
            try await install(payload: payload, version: release.version, instance: instance)
            try instance.rememberSelection()
            return HostCorePreparation(instance: instance.name, owner: .desktop,
                installedVersion: release.version, updateVersion: nil)
        }

        try instance.rememberSelection()
        // Check the installed reader, never an older reader bundled with the UI.
        if FileManager.default.fileExists(atPath: instance.root.appending(path: "config/node.env").path) {
            try await run(URL(filePath: "/bin/bash"), ["-c",
                #"source "$1"; exec "$ARU_NODE_BINARY" "$2" --data-dir "$ARU_DATA_DIR" --container-runtime none --check-state"#,
                "aru-state-check", instance.root.appending(path: "config/node.env").path, server.path])
        }
        // Starts a stopped, registered helper; never restarts a running one.
        // An independently managed process may not be registered with launchd.
        _ = try? await run(URL(filePath: "/bin/launchctl"),
            ["kickstart", "gui/\(getuid())/\(instance.launchLabel)"])
        let release = (try? payloadDirectory()).flatMap { try? Self.readRelease(from: $0) }
        let update: String?
        if owner == .desktop, let installed = record?.version, let release,
           HostSemanticVersion.isNewer(release.version, than: installed) {
            update = release.version
        } else { update = nil }
        return HostCorePreparation(instance: instance.name, owner: owner,
            installedVersion: record?.version, updateVersion: update)
    }

    /// Only the explicit update action may replace an existing installation.
    /// Re-read both selection and ownership, since either may have changed since
    /// the window opened. Unknown or newer installations are never downgraded.
    func update(expected: HostCorePreparation) async throws {
        let instance = try LocalHostInstance.resolve(homeDirectory: homeDirectory)
        guard instance.name == expected.instance,
              let record = try HostCoreInstallationRecord.read(at: instance.root.appending(path: "config/install.env")),
              record.owner == .desktop, record.version == expected.installedVersion,
              let installed = record.version else {
            throw HostCoreInstallationError.managedRepair
        }
        let payload = try payloadDirectory()
        let release = try Self.readRelease(from: payload)
        let newer = HostSemanticVersion.isNewer(release.version, than: installed)
        let repair = expected.operation == .repair && release.version == installed
            && !FileManager.default.fileExists(atPath: instance.root.appending(path: "current/server.mjs").path)
        guard newer || repair else { return }
        try await install(payload: payload, version: release.version, instance: instance)
    }

    private func payloadDirectory() throws -> URL {
        guard let payload = resourceRoot?.appending(path: "HostCore"),
              FileManager.default.fileExists(atPath: payload.path) else { throw HostCoreInstallationError.payloadMissing }
        return payload
    }

    private func install(payload: URL, version: String, instance: LocalHostInstance) async throws {
        let installer = payload.appending(path: "install-macos.sh")
        guard FileManager.default.isExecutableFile(atPath: installer.path) else { throw HostCoreInstallationError.installerMissing }
        try await run(URL(filePath: "/bin/bash"), [installer.path, "--source-dir", payload.path,
            "--instance", instance.name, "--base-root", instance.baseRoot.path, "--release-version", version, "--install-owner", "desktop"])
    }

    private static func readRelease(from payloadDirectory: URL) throws -> BundledRelease {
        do {
            let data = try Data(contentsOf: payloadDirectory.appending(path: "release.json"))
            let release = try JSONDecoder().decode(BundledRelease.self, from: data)
            guard release.schema == "aru.host.release.v1",
                  release.version.range(
                    of: #"^[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9.]+)?$"#,
                    options: .regularExpression) != nil else {
                throw HostCoreInstallationError.releaseInvalid
            }
            return release
        } catch let error as HostCoreInstallationError {
            throw error
        } catch {
            throw HostCoreInstallationError.releaseInvalid
        }
    }

}

enum HostCoreInstallationError: LocalizedError, Equatable {
    case chooseInstance([String])
    case independentRepair
    case managedRepair
    case payloadMissing
    case releaseInvalid
    case installerMissing
    case commandFailed(String?)

    var errorDescription: String? {
        switch self {
        case .chooseInstance: return L10n.hostChooseInstance
        case .independentRepair: return L10n.hostIndependentRepair
        case .managedRepair: return L10n.hostManagedRepair
        case .payloadMissing: return L10n.hostCorePayloadMissing
        case .releaseInvalid: return L10n.hostCoreReleaseInvalid
        case .installerMissing: return L10n.hostCoreInstallerMissing
        case .commandFailed(let detail):
            guard let detail, !detail.isEmpty else { return L10n.hostCoreInstallFailed }
            if detail.contains("host.state_unreadable") { return L10n.hostStateUnreadable }
            return "\(L10n.hostCoreInstallFailed)\n\(detail)"
        }
    }
}
