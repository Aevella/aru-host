import Foundation

struct LocalHostInstance: Equatable, Sendable {
    let name: String
    let baseRoot: URL
    var root: URL { baseRoot.appending(path: "instances/\(name)") }
    var launchLabel: String { "cn.aelion.aru-selfhost.\(name)" }
    var controlTool: URL { root.appending(path: "current/aru-selfhost") }
    var hasInstallation: Bool {
        FileManager.default.fileExists(atPath: root.appending(path: "config/install.env").path)
            || FileManager.default.fileExists(atPath: root.appending(path: "current/server.mjs").path)
    }

    init(homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser) {
        let base = Self.base(homeDirectory)
        let candidates = Self.installed(homeDirectory: homeDirectory)
        let selected = try? String(contentsOf: base.appending(path: "desktop-instance"), encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        baseRoot = base
        if let match = candidates.first(where: { $0.name == selected }) {
            name = match.name
        } else if candidates.count == 1 {
            name = candidates[0].name
        } else if candidates.isEmpty,
                  FileManager.default.fileExists(atPath: base.appending(path: "instances/home/data").path) {
            name = "home" // Restore retained data only when no installed service competes.
        } else {
            name = "default"
        }
    }

    private init(name: String, baseRoot: URL) {
        self.name = name
        self.baseRoot = baseRoot
    }

    private static func base(_ home: URL) -> URL {
        home.appending(path: "Library/Application Support/Aru Self-Hosted")
    }

    static func installed(homeDirectory: URL) -> [Self] {
        let base = base(homeDirectory)
        let names = (try? FileManager.default.contentsOfDirectory(atPath: base.appending(path: "instances").path)) ?? []
        return names.sorted().filter { $0.range(of: #"^[a-z0-9][a-z0-9-]{0,31}$"#, options: .regularExpression) != nil }
            .map { Self(name: $0, baseRoot: base) }.filter(\.hasInstallation)
    }

    static func resolve(homeDirectory: URL) throws -> Self {
        let candidates = installed(homeDirectory: homeDirectory)
        let selected = try? String(contentsOf: base(homeDirectory).appending(path: "desktop-instance"), encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if let match = candidates.first(where: { $0.name == selected }) { return match }
        guard candidates.count < 2 else { throw HostCoreInstallationError.chooseInstance(candidates.map(\.name)) }
        return Self(homeDirectory: homeDirectory)
    }

    func rememberSelection() throws {
        try FileManager.default.createDirectory(at: baseRoot, withIntermediateDirectories: true)
        try name.write(to: baseRoot.appending(path: "desktop-instance"), atomically: true, encoding: .utf8)
    }

    static func select(_ name: String, homeDirectory: URL) throws {
        guard let instance = installed(homeDirectory: homeDirectory).first(where: { $0.name == name }) else {
            throw HostCoreInstallationError.commandFailed(L10n.hostInstallationChanged)
        }
        try instance.rememberSelection()
    }
}
