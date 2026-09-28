import Foundation

enum HostInstallationOwner: String, Equatable, Sendable {
    case desktop
    case independent
}

enum HostCoreOperation: Equatable, Sendable { case update, repair }

struct HostCorePreparation: Equatable, Sendable {
    let instance: String
    let owner: HostInstallationOwner
    let installedVersion: String?
    let updateVersion: String?
    var operation: HostCoreOperation = .update
}

struct HostCoreInstallationRecord {
    let contents: String
    var owner: HostInstallationOwner {
        if let value = value("ARU_INSTALL_OWNER") { return HostInstallationOwner(rawValue: value) ?? .independent }
        // Legacy desktop installers recorded their bundled source. A name such
        // as "home", or a version alone, is not evidence of desktop ownership.
        if value("ARU_INSTALL_SOURCE_DIR")?.contains(".app/Contents/Resources/HostCore") == true { return .desktop }
        return .independent
    }
    var version: String? { value("ARU_INSTALL_RELEASE_VERSION") }

    func value(_ key: String) -> String? {
        guard let line = contents.split(whereSeparator: \.isNewline).last(where: { $0.hasPrefix(key + "=") }) else { return nil }
        let value = String(line.dropFirst(key.count + 1)).trimmingCharacters(in: CharacterSet(charactersIn: "'\""))
        return value.isEmpty ? nil : value
    }

    static func read(at url: URL) throws -> Self? {
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        return Self(contents: try String(contentsOf: url, encoding: .utf8))
    }

    func persistLegacyOwner(at url: URL) throws {
        guard value("ARU_INSTALL_OWNER") == nil else { return }
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        try (contents + "\nARU_INSTALL_OWNER=" + owner.rawValue + "\n").write(to: url, atomically: true, encoding: .utf8)
        if let permissions = attributes[.posixPermissions] {
            try FileManager.default.setAttributes([.posixPermissions: permissions], ofItemAtPath: url.path)
        }
    }
}
