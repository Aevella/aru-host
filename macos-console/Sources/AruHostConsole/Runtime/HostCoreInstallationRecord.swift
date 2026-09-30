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
        let data = try Data(contentsOf: url)
        if let contents = String(data: data, encoding: .utf8) { return Self(contents: contents) }
        // Bash 3.2 %q under a UTF-8 locale can mix raw bytes and octal escapes
        // inside ANSI-C quotes. Preserve those shell bytes, without executing the file.
        let lines = data.split(separator: 10, omittingEmptySubsequences: false)
        var normalized: [String] = []
        for line in lines {
            if let text = String(data: Data(line), encoding: .utf8) {
                normalized.append(text)
                continue
            }
            guard let equal = line.firstIndex(of: 61),
                  Array(line.suffix(from: line.index(after: equal)).prefix(2)) == [36, 39],
                  line.last == 39 else {
                throw CocoaError(.fileReadInapplicableStringEncoding)
            }
            normalized.append(line.map { byte in
                byte < 128 ? String(UnicodeScalar(byte)) : String(format: "\\%03o", byte)
            }.joined())
        }
        let contents = normalized.joined(separator: "\n")
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        try contents.write(to: url, atomically: true, encoding: .utf8)
        if let permissions = attributes[.posixPermissions] {
            try FileManager.default.setAttributes([.posixPermissions: permissions], ofItemAtPath: url.path)
        }
        return Self(contents: contents)
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
