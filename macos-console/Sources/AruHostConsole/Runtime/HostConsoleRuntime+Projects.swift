import Foundation

@MainActor
extension HostConsoleRuntime {
    func refreshProjects(collaboratorId: String) async throws {
        let inventory: HostCollaboratorProjectInventory = try await request(
            projectRoot(collaboratorId), authenticated: true)
        guard inventory.schema == "aru.selfhost.collaborator-project-inventory.v1",
              inventory.collaboratorId == collaboratorId else {
            throw HostConsoleModelError.invalidCollaboratorSchema
        }
        let projects = inventory.projects.sorted {
            $0.updatedAt == $1.updatedAt ? $0.projectId < $1.projectId : $0.updatedAt > $1.updatedAt
        }
        guard collaboratorProjects[collaboratorId] != projects else { return }
        collaboratorProjects[collaboratorId] = projects
    }

    @discardableResult
    func createProject(collaboratorId: String,
                       title: String,
                       repositoryURL: String?,
                       entryPath: String) async throws -> HostCollaboratorProject {
        let mutationId = "new::\(collaboratorId)"
        return try await mutateProject(mutationId: mutationId) {
            let body = try JSONEncoder().encode(CreateHostCollaboratorProjectBody(
                title: title.trimmingCharacters(in: .whitespacesAndNewlines),
                repositoryURL: repositoryURL?.trimmingCharacters(in: .whitespacesAndNewlines),
                entryPath: entryPath.trimmingCharacters(in: .whitespacesAndNewlines)))
            let project: HostCollaboratorProject = try await request(
                projectRoot(collaboratorId), method: "POST", body: body, authenticated: true)
            try acceptProject(project, collaboratorId: collaboratorId)
            return project
        }
    }

    @discardableResult
    func checkpointProject(collaboratorId: String,
                           project: HostCollaboratorProject,
                           note: String) async throws -> HostCollaboratorProjectCheckpointReceipt {
        try await mutateProject(mutationId: project.projectId) {
            let body = try JSONEncoder().encode(CheckpointHostCollaboratorProjectBody(
                expectedRevision: project.revision,
                note: note.trimmingCharacters(in: .whitespacesAndNewlines)))
            let receipt: HostCollaboratorProjectCheckpointReceipt = try await request(
                "\(projectRoot(collaboratorId))/\(project.projectId)/checkpoint",
                method: "POST", body: body, authenticated: true)
            try acceptProject(receipt.project, collaboratorId: collaboratorId)
            return receipt
        }
    }

    @discardableResult
    func publishProject(collaboratorId: String,
                        project: HostCollaboratorProject,
                        note: String,
                        allowsOutboundNetwork: Bool) async throws -> HostCollaboratorProjectPublishReceipt {
        try await mutateProject(mutationId: project.projectId) {
            let expectedSurfaceRevision = collaboratorSurfaces[collaboratorId]?
                .first(where: { $0.surfaceId == project.surfaceId })?.revision
            let body = try JSONEncoder().encode(PublishHostCollaboratorProjectBody(
                expectedRevision: project.revision,
                expectedSurfaceRevision: expectedSurfaceRevision,
                note: note.trimmingCharacters(in: .whitespacesAndNewlines),
                networkAccess: allowsOutboundNetwork ? "outbound" : "none"))
            let receipt: HostCollaboratorProjectPublishReceipt = try await request(
                "\(projectRoot(collaboratorId))/\(project.projectId)/publish",
                method: "POST", body: body, authenticated: true)
            try acceptProject(receipt.project, collaboratorId: collaboratorId)
            try await refreshSurfaces(collaboratorId: collaboratorId)
            return receipt
        }
    }

    private func projectRoot(_ collaboratorId: String) -> String {
        "/aru/v1/hosted-collaborators/\(collaboratorId)/projects"
    }

    private func acceptProject(_ project: HostCollaboratorProject,
                               collaboratorId: String) throws {
        guard project.schema == "aru.selfhost.collaborator-project.v1",
              project.collaboratorId == collaboratorId else {
            throw HostConsoleModelError.invalidCollaboratorSchema
        }
        var projects = collaboratorProjects[collaboratorId] ?? []
        projects.removeAll { $0.projectId == project.projectId }
        projects.insert(project, at: 0)
        collaboratorProjects[collaboratorId] = projects
    }

    private func mutateProject<Value>(mutationId: String,
                                      operation: () async throws -> Value) async throws -> Value {
        guard !mutatingProjectIds.contains(mutationId) else {
            throw HostConsoleHTTPError.server(L10n.projectMutationInProgress)
        }
        mutatingProjectIds.insert(mutationId)
        defer { mutatingProjectIds.remove(mutationId) }
        return try await operation()
    }
}
