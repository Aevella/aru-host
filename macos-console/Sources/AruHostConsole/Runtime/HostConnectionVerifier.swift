import Foundation

enum HostConnectionVerifier {
    static func verify(_ address: String, expectedServerId: String?, session: URLSession) async throws {
        guard let url = URL(string: address), ["http", "https"].contains(url.scheme),
              url.host != nil, url.user == nil, url.password == nil,
              url.path.isEmpty || url.path == "/", url.query == nil, url.fragment == nil else {
            throw HostAddressCheckError.invalid
        }
        // Probe only the public manifest. Never send a paired credential to an unverified address.
        let (data, response) = try await session.data(from: url.appending(path: ".well-known/aru.json"))
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw HostAddressCheckError.unavailable }
        let candidate = try JSONDecoder().decode(HostManifest.self, from: data)
        try candidate.validate()
        guard candidate.serverId == expectedServerId else { throw HostAddressCheckError.differentHost }
    }
}

enum HostAddressCheckError: LocalizedError {
    case invalid, unavailable, differentHost
    var errorDescription: String? {
        switch self {
        case .invalid: L10n.connectionInvalid
        case .unavailable: L10n.connectionUnavailable
        case .differentHost: L10n.connectionDifferentHost
        }
    }
}
