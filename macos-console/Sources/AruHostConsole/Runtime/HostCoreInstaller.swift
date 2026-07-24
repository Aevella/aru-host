import Darwin
import Foundation

protocol HostCoreInstalling: Sendable {
    func prepare() async throws
}

struct BundledHostCoreInstaller: HostCoreInstalling {
    private struct BundledRelease: Decodable {
        let schema: String
        let version: String
    }

    private let resourceRoot: URL?
    private let homeDirectory: URL

    init(
        resourceRoot: URL? = Bundle.main.resourceURL,
        homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser
    ) {
        self.resourceRoot = resourceRoot
        self.homeDirectory = homeDirectory
    }

    func prepare() async throws {
        guard let payloadDirectory = resourceRoot?.appending(path: "HostCore", directoryHint: .isDirectory),
              FileManager.default.fileExists(atPath: payloadDirectory.path) else {
            throw HostCoreInstallationError.payloadMissing
        }
        let release = try Self.readRelease(from: payloadDirectory)
        let baseRoot = homeDirectory.appending(
            path: "Library/Application Support/Aru Self-Hosted",
            directoryHint: .isDirectory)
        let installedVersion = Self.installedReleaseVersion(
            at: baseRoot.appending(path: "instances/home/config/install.env"))
        let controlTool = homeDirectory.appending(path: ".local/bin/aru-selfhost")

        if installedVersion != release.version ||
            !FileManager.default.isExecutableFile(atPath: controlTool.path) {
            let installer = payloadDirectory.appending(path: "install-macos.sh")
            guard FileManager.default.isExecutableFile(atPath: installer.path) else {
                throw HostCoreInstallationError.installerMissing
            }
            try await Self.run(
                executable: URL(filePath: "/bin/bash"),
                arguments: [
                    installer.path,
                    "--source-dir", payloadDirectory.path,
                    "--instance", "home",
                    "--release-version", release.version,
                ])
            return
        }

        // `kickstart` without `-k` starts a stopped helper but leaves an already
        // running Host and its in-flight work untouched.
        _ = try? await Self.run(
            executable: URL(filePath: "/bin/launchctl"),
            arguments: ["kickstart", "gui/\(getuid())/cn.aelion.aru-selfhost.home"])
    }

    static func installedReleaseVersion(in contents: String) -> String? {
        guard let line = contents.split(whereSeparator: \.isNewline)
            .first(where: { $0.hasPrefix("ARU_INSTALL_RELEASE_VERSION=") }) else {
            return nil
        }
        let raw = line.dropFirst("ARU_INSTALL_RELEASE_VERSION=".count)
        let value = String(raw).trimmingCharacters(in: CharacterSet(charactersIn: "'\""))
        return value.isEmpty ? nil : value
    }

    private static func installedReleaseVersion(at url: URL) -> String? {
        guard let contents = try? String(contentsOf: url, encoding: .utf8) else { return nil }
        return installedReleaseVersion(in: contents)
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

    private static func run(executable: URL, arguments: [String]) async throws {
        try await Task.detached {
            let process = Process()
            let output = Pipe()
            let errors = Pipe()
            process.executableURL = executable
            process.arguments = arguments
            process.standardOutput = output
            process.standardError = errors
            try process.run()
            process.waitUntilExit()
            guard process.terminationStatus == 0 else {
                let data = errors.fileHandleForReading.readDataToEndOfFile()
                let detail = String(data: data, encoding: .utf8)?
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                throw HostCoreInstallationError.commandFailed(detail)
            }
        }.value
    }
}

enum HostCoreInstallationError: LocalizedError, Equatable {
    case payloadMissing
    case releaseInvalid
    case installerMissing
    case commandFailed(String?)

    var errorDescription: String? {
        switch self {
        case .payloadMissing: return L10n.hostCorePayloadMissing
        case .releaseInvalid: return L10n.hostCoreReleaseInvalid
        case .installerMissing: return L10n.hostCoreInstallerMissing
        case .commandFailed(let detail):
            guard let detail, !detail.isEmpty else { return L10n.hostCoreInstallFailed }
            return "\(L10n.hostCoreInstallFailed)\n\(detail)"
        }
    }
}
