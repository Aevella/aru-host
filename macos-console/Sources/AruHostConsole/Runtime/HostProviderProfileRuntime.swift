import Foundation

@MainActor
final class HostProviderProfileRuntime: ObservableObject {
    @Published private(set) var profiles: [HostProviderProfile] = []
    @Published private(set) var secretStorage: HostProviderSecretStorage?
    @Published private(set) var isLoading = false
    @Published private(set) var mutatingProfileIds: Set<String> = []
    @Published private(set) var errorMessage: String?

    private let session: URLSession
    private let vault: HostCredentialVault
    private let baseURL: URL

    init(
        session: URLSession = .shared,
        vault: HostCredentialVault = HostCredentialVault(),
        baseURL: URL = LocalHostLocator.baseURL()
    ) {
        self.session = session
        self.vault = vault
        self.baseURL = baseURL
    }

    func refresh() async {
        guard !isLoading else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            let inventory: HostProviderProfileInventory = try await request("/aru/v1/provider-profiles")
            profiles = inventory.profiles.sorted { $0.updatedAt > $1.updatedAt }
            secretStorage = inventory.secretStorage
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    @discardableResult
    func save(
        profile: HostProviderProfile?,
        displayName: String,
        protocol providerProtocol: HostProviderProtocol,
        baseURL: String,
        path: String,
        model: String,
        authMode: HostProviderAuthMode,
        maxOutputTokens: Int?,
        maxToolRounds: Int?,
        apiKey: String
    ) async throws -> HostProviderProfile {
        let mutationId = profile?.profileId ?? "new"
        guard !mutatingProfileIds.contains(mutationId) else {
            throw HostConsoleHTTPError.server(L10n.providerMutationInProgress)
        }
        mutatingProfileIds.insert(mutationId)
        defer { mutatingProfileIds.remove(mutationId) }
        let payload = HostProviderProfileMutation(
            expectedRevision: profile?.revision,
            displayName: displayName.trimmingCharacters(in: .whitespacesAndNewlines),
            protocol: providerProtocol,
            baseURL: baseURL.trimmingCharacters(in: .whitespacesAndNewlines),
            path: path.trimmingCharacters(in: .whitespacesAndNewlines),
            model: model.trimmingCharacters(in: .whitespacesAndNewlines),
            authMode: authMode,
            maxOutputTokens: providerProtocol == .anthropicMessages ? maxOutputTokens : nil,
            maxToolRounds: maxToolRounds,
            apiKey: apiKey.isEmpty ? nil : apiKey
        )
        let body = try JSONEncoder().encode(payload)
        let saved: HostProviderProfile = try await request(
            profile == nil ? "/aru/v1/provider-profiles" : "/aru/v1/provider-profiles/\(profile!.profileId)",
            method: profile == nil ? "POST" : "PUT",
            body: body
        )
        merge(saved)
        errorMessage = nil
        return saved
    }

    @discardableResult
    func test(_ profile: HostProviderProfile) async throws -> HostProviderProfile {
        guard !mutatingProfileIds.contains(profile.profileId) else {
            throw HostConsoleHTTPError.server(L10n.providerMutationInProgress)
        }
        mutatingProfileIds.insert(profile.profileId)
        defer { mutatingProfileIds.remove(profile.profileId) }
        let checked: HostProviderProfile = try await request(
            "/aru/v1/provider-profiles/\(profile.profileId)/test",
            method: "POST"
        )
        merge(checked)
        errorMessage = nil
        return checked
    }

    func delete(_ profile: HostProviderProfile) async throws {
        guard !mutatingProfileIds.contains(profile.profileId) else { return }
        mutatingProfileIds.insert(profile.profileId)
        defer { mutatingProfileIds.remove(profile.profileId) }
        let _: HostProviderProfileDeletion = try await request(
            "/aru/v1/provider-profiles/\(profile.profileId)",
            method: "DELETE"
        )
        profiles.removeAll { $0.profileId == profile.profileId }
        errorMessage = nil
    }

    private func merge(_ profile: HostProviderProfile) {
        if let index = profiles.firstIndex(where: { $0.profileId == profile.profileId }) {
            profiles[index] = profile
        } else {
            profiles.insert(profile, at: 0)
        }
    }

    private func request<Response: Decodable>(
        _ path: String,
        method: String = "GET",
        body: Data? = nil
    ) async throws -> Response {
        guard let url = URL(string: path, relativeTo: baseURL) else {
            throw HostConsoleHTTPError.invalidURL
        }
        guard let credential = try vault.read() else {
            throw HostConsoleHTTPError.unauthorized
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("Bearer \(credential)", forHTTPHeaderField: "Authorization")
        if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw HostConsoleHTTPError.invalidResponse
        }
        if http.statusCode == 401 || http.statusCode == 403 {
            throw HostConsoleHTTPError.unauthorized
        }
        guard (200..<300).contains(http.statusCode) else {
            let apiError = try? JSONDecoder().decode(HostAPIError.self, from: data)
            throw HostConsoleHTTPError.server(apiError?.message ?? apiError?.error ?? "HTTP \(http.statusCode)")
        }
        return try JSONDecoder().decode(Response.self, from: data)
    }
}
