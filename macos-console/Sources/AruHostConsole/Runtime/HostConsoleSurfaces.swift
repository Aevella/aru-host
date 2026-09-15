import Foundation
import Observation

@MainActor @Observable
final class HostConsoleSurfaces {
    private(set) var collaboratorSurfaces: [String: [HostCollaboratorSurface]] = [:]
    private(set) var mutatingSurfaceIds: Set<String> = []
    private let load: (String, String, Data?) async throws -> Data
    private let didUpdate: () -> Void
    private var generation = 0
    init(load: @escaping (String, String, Data?) async throws -> Data,
         didUpdate: @escaping () -> Void = {}) {
        self.load = load
        self.didUpdate = didUpdate
    }
    func clear() {
        generation += 1
        collaboratorSurfaces = [:]
        mutatingSurfaceIds = []
    }
    private func request<Response: Decodable>(_ path: String, method: String = "GET",
        body: Data? = nil) async throws -> Response {
        let epoch = generation
        let data = try await load(path, method, body)
        guard epoch == generation else { throw CancellationError() }
        return try JSONDecoder().decode(Response.self, from: data)
    }
    func surfaceDetail(collaboratorId: String,
                       surfaceId: String) async throws -> HostCollaboratorSurface {
        try await request(
            "/aru/v1/hosted-collaborators/\(collaboratorId)/surfaces/\(surfaceId)")
    }

    func surfaceBundle(collaboratorId: String,
                       surfaceId: String,
                       versionId: String) async throws -> HostCollaboratorSurfaceBundle {
        try await request(
            "/aru/v1/hosted-collaborators/\(collaboratorId)/surfaces/\(surfaceId)/versions/\(versionId)/bundle")
    }

    @discardableResult
    func publishSurface(collaborator: HostedCollaborator,
                        surface: HostCollaboratorSurface?,
                        title: String,
                        sourceHTML: String,
                        note: String,
                        allowsOutboundNetwork: Bool) async throws -> HostCollaboratorSurface {
        let mutationId = surface?.surfaceId ?? "new::\(collaborator.id)"
        guard !mutatingSurfaceIds.contains(mutationId) else {
            throw HostConsoleHTTPError.server(L10n.surfaceMutationInProgress)
        }
        let epoch = generation
        mutatingSurfaceIds.insert(mutationId)
        defer { if epoch == generation { mutatingSurfaceIds.remove(mutationId) } }
        let path: String
        let body: Data
        let method: String
        if let surface {
            path = "/aru/v1/hosted-collaborators/\(collaborator.id)/surfaces/\(surface.surfaceId)"
            method = "PUT"
            body = try JSONEncoder().encode(UpdateHostCollaboratorSurfaceBody(
                expectedRevision: surface.revision,
                title: title.trimmingCharacters(in: .whitespacesAndNewlines),
                sourceHTML: sourceHTML,
                note: note.trimmingCharacters(in: .whitespacesAndNewlines),
                networkAccess: allowsOutboundNetwork ? "outbound" : "none"))
        } else {
            path = "/aru/v1/hosted-collaborators/\(collaborator.id)/surfaces"
            method = "POST"
            body = try JSONEncoder().encode(CreateHostCollaboratorSurfaceBody(
                title: title.trimmingCharacters(in: .whitespacesAndNewlines),
                sourceHTML: sourceHTML,
                note: note.trimmingCharacters(in: .whitespacesAndNewlines),
                networkAccess: allowsOutboundNetwork ? "outbound" : "none"))
        }
        let updated: HostCollaboratorSurface = try await request(
            path, method: method, body: body)
        guard epoch == generation else { throw CancellationError() }
        try await refreshSurfaces(collaboratorId: collaborator.id)
        didUpdate()
        return updated
    }

    @discardableResult
    func setSurfaceNetworkAccess(_ allowsOutboundNetwork: Bool,
                                 collaborator: HostedCollaborator,
                                 surface: HostCollaboratorSurface) async throws -> HostCollaboratorSurface {
        guard !mutatingSurfaceIds.contains(surface.surfaceId) else {
            throw HostConsoleHTTPError.server(L10n.surfaceMutationInProgress)
        }
        let epoch = generation
        mutatingSurfaceIds.insert(surface.surfaceId)
        defer { if epoch == generation { mutatingSurfaceIds.remove(surface.surfaceId) } }
        let body = try JSONEncoder().encode(UpdateHostCollaboratorSurfaceRuntimeBody(
            expectedRevision: surface.revision,
            networkAccess: allowsOutboundNetwork ? "outbound" : "none"))
        let updated: HostCollaboratorSurface = try await request(
            "/aru/v1/hosted-collaborators/\(collaborator.id)/surfaces/\(surface.surfaceId)/runtime",
            method: "PUT",
            body: body)
        guard epoch == generation else { throw CancellationError() }
        try await refreshSurfaces(collaboratorId: collaborator.id)
        didUpdate()
        return updated
    }

    @discardableResult
    func rollbackSurface(collaborator: HostedCollaborator,
                         surface: HostCollaboratorSurface,
                         versionId: String) async throws -> HostCollaboratorSurface {
        guard !mutatingSurfaceIds.contains(surface.surfaceId) else {
            throw HostConsoleHTTPError.server(L10n.surfaceMutationInProgress)
        }
        let epoch = generation
        mutatingSurfaceIds.insert(surface.surfaceId)
        defer { if epoch == generation { mutatingSurfaceIds.remove(surface.surfaceId) } }
        let body = try JSONEncoder().encode(RollbackHostCollaboratorSurfaceBody(
            expectedRevision: surface.revision,
            versionId: versionId,
            note: L10n.surfaceRollbackNote))
        let updated: HostCollaboratorSurface = try await request(
            "/aru/v1/hosted-collaborators/\(collaborator.id)/surfaces/\(surface.surfaceId)/rollback",
            method: "POST",
            body: body)
        guard epoch == generation else { throw CancellationError() }
        try await refreshSurfaces(collaboratorId: collaborator.id)
        didUpdate()
        return updated
    }

    @discardableResult
    func setSurfaceArchived(_ archived: Bool,
                            collaborator: HostedCollaborator,
                            surface: HostCollaboratorSurface) async throws -> HostCollaboratorSurface {
        guard !mutatingSurfaceIds.contains(surface.surfaceId) else {
            throw HostConsoleHTTPError.server(L10n.surfaceMutationInProgress)
        }
        let epoch = generation
        mutatingSurfaceIds.insert(surface.surfaceId)
        defer { if epoch == generation { mutatingSurfaceIds.remove(surface.surfaceId) } }
        let body = try JSONEncoder().encode(ArchiveHostCollaboratorSurfaceBody(
            expectedRevision: surface.revision))
        let action = archived ? "archive" : "restore"
        let updated: HostCollaboratorSurface = try await request(
            "/aru/v1/hosted-collaborators/\(collaborator.id)/surfaces/\(surface.surfaceId)/\(action)",
            method: "POST",
            body: body)
        guard epoch == generation else { throw CancellationError() }
        try await refreshSurfaces(collaboratorId: collaborator.id)
        didUpdate()
        return updated
    }

    func refreshSurfaces(collaboratorId: String) async throws {
        let inventory: HostCollaboratorSurfaceInventory = try await request(
            "/aru/v1/hosted-collaborators/\(collaboratorId)/surfaces")
        guard inventory.schema == "aru.selfhost.collaborator-surface-inventory.v1",
              inventory.collaboratorId == collaboratorId else {
            throw HostConsoleModelError.invalidCollaboratorSchema
        }
        if collaboratorSurfaces[collaboratorId] != inventory.surfaces {
            collaboratorSurfaces[collaboratorId] = inventory.surfaces
        }
        didUpdate()
    }

}
