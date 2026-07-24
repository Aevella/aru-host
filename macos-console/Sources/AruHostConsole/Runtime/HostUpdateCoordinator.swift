import AppKit
import Foundation

struct HostAppUpdate: Equatable, Sendable {
    let version: String
    let downloadURL: URL
    let releaseURL: URL
}

enum HostUpdateState: Equatable {
    case idle
    case checking
    case current
    case available(HostAppUpdate)
    case failure(String)
}

@MainActor
final class HostUpdateCoordinator: ObservableObject {
    private struct GitHubRelease: Decodable {
        struct Asset: Decodable {
            let name: String
            let browserDownloadURL: URL

            enum CodingKeys: String, CodingKey {
                case name
                case browserDownloadURL = "browser_download_url"
            }
        }

        let tagName: String
        let htmlURL: URL
        let assets: [Asset]

        enum CodingKeys: String, CodingKey {
            case tagName = "tag_name"
            case htmlURL = "html_url"
            case assets
        }
    }

    @Published private(set) var state: HostUpdateState = .idle

    private let session: URLSession
    private let currentVersion: String
    private let endpoint: URL

    init(
        session: URLSession = .shared,
        currentVersion: String = Bundle.main.object(
            forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.0.0",
        endpoint: URL = URL(string: "https://api.github.com/repos/Aevella/aru-host/releases/latest")!
    ) {
        self.session = session
        self.currentVersion = currentVersion
        self.endpoint = endpoint
    }

    func check() async {
        guard state != .checking else { return }
        state = .checking
        do {
            var request = URLRequest(url: endpoint)
            request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
            request.setValue("Aru-Host/\(currentVersion)", forHTTPHeaderField: "User-Agent")
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse,
                  (200..<300).contains(http.statusCode) else {
                throw HostUpdateError.releaseUnavailable
            }
            let release = try JSONDecoder().decode(GitHubRelease.self, from: data)
            let version = release.tagName.hasPrefix("v")
                ? String(release.tagName.dropFirst())
                : release.tagName
            guard HostSemanticVersion.isNewer(version, than: currentVersion) else {
                state = .current
                return
            }
            guard let asset = release.assets.first(where: {
                $0.name.hasSuffix(".dmg") && $0.name.contains("aru-host-macos")
            }) else {
                throw HostUpdateError.assetMissing
            }
            state = .available(HostAppUpdate(
                version: version,
                downloadURL: asset.browserDownloadURL,
                releaseURL: release.htmlURL))
        } catch {
            state = .failure(error.localizedDescription)
        }
    }

    func open(_ update: HostAppUpdate) {
        NSWorkspace.shared.open(update.downloadURL)
    }
}

enum HostSemanticVersion {
    private struct Value: Comparable {
        let numbers: [Int]
        let prerelease: String?

        static func < (lhs: Value, rhs: Value) -> Bool {
            let count = max(lhs.numbers.count, rhs.numbers.count)
            for index in 0..<count {
                let left = index < lhs.numbers.count ? lhs.numbers[index] : 0
                let right = index < rhs.numbers.count ? rhs.numbers[index] : 0
                if left != right { return left < right }
            }
            switch (lhs.prerelease, rhs.prerelease) {
            case (.some, .none): return true
            case (.none, .some): return false
            case (.some(let left), .some(let right)): return left < right
            case (.none, .none): return false
            }
        }
    }

    static func isNewer(_ candidate: String, than current: String) -> Bool {
        guard let candidate = parse(candidate), let current = parse(current) else { return false }
        return candidate > current
    }

    private static func parse(_ input: String) -> Value? {
        let parts = input.split(separator: "-", maxSplits: 1, omittingEmptySubsequences: false)
        let numbers = parts[0].split(separator: ".").compactMap { Int($0) }
        guard numbers.count == parts[0].split(separator: ".").count,
              numbers.count >= 3 else { return nil }
        let prerelease = parts.count == 2 && !parts[1].isEmpty ? String(parts[1]) : nil
        return Value(numbers: numbers, prerelease: prerelease)
    }
}

enum HostUpdateError: LocalizedError {
    case releaseUnavailable
    case assetMissing

    var errorDescription: String? {
        switch self {
        case .releaseUnavailable: return L10n.updateReleaseUnavailable
        case .assetMissing: return L10n.updateAssetMissing
        }
    }
}
