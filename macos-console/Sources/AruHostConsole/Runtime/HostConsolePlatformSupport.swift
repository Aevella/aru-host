import Foundation

enum HostConsoleHTTPError: LocalizedError {
    case invalidURL
    case invalidResponse
    case unauthorized
    case server(String)

    var errorDescription: String? {
        switch self {
        case .invalidURL: L10n.invalidURL
        case .invalidResponse: L10n.invalidResponse
        case .unauthorized: L10n.pairingExpired
        case .server(let message): message
        }
    }
}

enum LocalHostLocator {
    static func baseURL() -> URL {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let envURL = home.appending(path: "Library/Application Support/Aru Self-Hosted/instances/home/config/node.env")
        guard let contents = try? String(contentsOf: envURL, encoding: .utf8),
              let portLine = contents.split(separator: "\n").first(where: { $0.hasPrefix("ARU_PORT=") }),
              let port = Int(portLine.dropFirst("ARU_PORT=".count)),
              let url = URL(string: "http://127.0.0.1:\(port)") else {
            return URL(string: "http://127.0.0.1:8787")!
        }
        return url
    }
}

enum LocalPairingIssuer {
    static func issueLink() throws -> String {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let executable = home.appending(path: ".local/bin/aru-selfhost")
        guard FileManager.default.isExecutableFile(atPath: executable.path) else {
            throw LocalPairingError.controlToolMissing
        }
        let process = Process()
        let output = Pipe()
        let error = Pipe()
        process.executableURL = executable
        process.arguments = ["--instance", "home", "pairing"]
        process.standardOutput = output
        process.standardError = error
        try process.run()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            throw LocalPairingError.commandFailed
        }
        let data = output.fileHandleForReading.readDataToEndOfFile()
        guard let text = String(data: data, encoding: .utf8),
              let link = pairingLink(from: text) else {
            throw LocalPairingError.invalidPairingLink
        }
        return link
    }

    static func issueToken() throws -> String {
        guard let components = URLComponents(string: try issueLink()),
              let token = components.queryItems?.first(where: { $0.name == "pairingToken" })?.value,
              !token.isEmpty else {
            throw LocalPairingError.invalidPairingLink
        }
        return token
    }

    static func pairingLink(from output: String) -> String? {
        for line in output.split(whereSeparator: \.isNewline) {
            let candidate = String(line).trimmingCharacters(in: .whitespacesAndNewlines)
            guard candidate.hasPrefix("aru://pair?"),
                  let components = URLComponents(string: candidate) else { continue }
            let query = (components.queryItems ?? []).reduce(into: [String: String]()) { values, item in
                guard values[item.name] == nil, let value = item.value else { return }
                values[item.name] = value
            }
            guard query["canonicalUrl"]?.isEmpty == false,
                  query["serverId"]?.isEmpty == false,
                  query["pairingToken"]?.isEmpty == false else { continue }
            return candidate
        }
        return nil
    }
}

enum LocalPairingError: LocalizedError {
    case controlToolMissing
    case commandFailed
    case invalidPairingLink

    var errorDescription: String? {
        switch self {
        case .controlToolMissing: L10n.controlToolMissing
        case .commandFailed: L10n.pairingCommandFailed
        case .invalidPairingLink: L10n.invalidPairingLink
        }
    }
}
