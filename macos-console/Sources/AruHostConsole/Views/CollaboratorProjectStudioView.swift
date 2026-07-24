import SwiftUI

struct CollaboratorProjectStudioView: View {
    @ObservedObject var runtime: HostConsoleRuntime
    let collaborator: HostedCollaborator

    @State private var title = ""
    @State private var repositoryURL = ""
    @State private var entryPath = "index.html"
    @State private var notes: [String: String] = [:]
    @State private var outboundProjectIds: Set<String> = []
    @State private var errorMessage: String?
    @State private var successMessage: String?

    var body: some View {
        HStack(spacing: 0) {
            composer
                .frame(width: 360)
            Divider().overlay(Color.white.opacity(0.48))
            projectList
        }
        .task { await refresh() }
    }

    private var composer: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(L10n.projectNew)
                        .font(.system(size: 18, weight: .semibold, design: .rounded))
                    Text(L10n.projectNewDetail)
                        .font(.system(size: 11, design: .rounded))
                        .foregroundStyle(HostPalette.secondaryInk.opacity(0.66))
                }
                TextField(L10n.projectTitle, text: $title)
                    .textFieldStyle(.roundedBorder)
                TextField(L10n.projectGitHub, text: $repositoryURL)
                    .textFieldStyle(.roundedBorder)
                TextField(L10n.projectEntry, text: $entryPath)
                    .textFieldStyle(.roundedBorder)
                Button {
                    Task { await create() }
                } label: {
                    Label(L10n.projectCreate, systemImage: "folder.badge.plus")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(FloatingGlassButtonStyle())
                .disabled(title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isCreating)
                if let successMessage {
                    Label(successMessage, systemImage: "checkmark.circle.fill")
                        .font(.system(size: 11, design: .rounded))
                        .foregroundStyle(HostPalette.mint)
                }
                if let errorMessage {
                    Text(errorMessage)
                        .font(.system(size: 11, design: .rounded))
                        .foregroundStyle(HostPalette.rose)
                }
            }
            .padding(22)
        }
    }

    private var projectList: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 12) {
                HStack {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(L10n.projects)
                            .font(.system(size: 18, weight: .semibold, design: .rounded))
                        Text(L10n.projectOwnedByHost)
                            .font(.system(size: 11, design: .rounded))
                            .foregroundStyle(HostPalette.secondaryInk.opacity(0.66))
                    }
                    Spacer()
                    Button { Task { await refresh() } } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                    .buttonStyle(StudioIconButtonStyle(tint: HostPalette.lavender.opacity(0.18)))
                }
                if projects.isEmpty {
                    ContentUnavailableView(L10n.projectEmpty,
                                           systemImage: "macwindow.badge.plus",
                                           description: Text(L10n.projectEmptyDetail))
                        .frame(maxWidth: .infinity, minHeight: 360)
                } else {
                    ForEach(projects) { project in
                        projectCard(project)
                    }
                }
            }
            .padding(22)
        }
    }

    private func projectCard(_ project: HostCollaboratorProject) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 11) {
                Image(systemName: project.repository == nil ? "folder" : "arrow.triangle.branch")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(HostPalette.lavenderDeep)
                    .frame(width: 38, height: 38)
                    .background(HostPalette.lavender.opacity(0.16), in: Circle())
                VStack(alignment: .leading, spacing: 3) {
                    Text(project.title)
                        .font(.system(size: 14, weight: .semibold, design: .rounded))
                    Text(project.workspacePath)
                        .font(.system(size: 10.5, design: .monospaced))
                        .foregroundStyle(HostPalette.secondaryInk.opacity(0.58))
                        .lineLimit(1)
                }
                Spacer()
                Circle()
                    .fill(project.repository?.state == "unavailable" ? HostPalette.rose : HostPalette.mint)
                    .frame(width: 7, height: 7)
                    .padding(.top, 6)
            }
            if let repository = project.repository {
                VStack(alignment: .leading, spacing: 5) {
                    Text(repository.sourceURL ?? repository.repositoryURL ?? "GitHub")
                        .font(.system(size: 10.5, design: .rounded))
                        .foregroundStyle(HostPalette.secondaryInk.opacity(0.72))
                        .lineLimit(1)
                    HStack(spacing: 9) {
                        if let branch = repository.branch {
                            Label(branch, systemImage: "arrow.triangle.branch")
                        }
                        if let commit = repository.commit {
                            Text(String(commit.prefix(8))).fontDesign(.monospaced)
                        }
                        if repository.dirty == true { Text(L10n.projectDirty) }
                        if (repository.ahead ?? 0) > 0 || (repository.behind ?? 0) > 0 {
                            Text("↑\(repository.ahead ?? 0) ↓\(repository.behind ?? 0)")
                        }
                    }
                    .font(.system(size: 10, design: .rounded))
                    .foregroundStyle(HostPalette.secondaryInk.opacity(0.58))
                }
            }
            HStack(spacing: 12) {
                Label(L10n.projectCheckpoints(project.checkpointCount), systemImage: "archivebox")
                Label(project.surfaceId == nil ? L10n.projectUnpublished : L10n.projectPublished,
                      systemImage: project.surfaceId == nil ? "iphone.slash" : "iphone")
            }
            .font(.system(size: 10.5, design: .rounded))
            .foregroundStyle(HostPalette.secondaryInk.opacity(0.58))
            TextField(L10n.projectNote,
                      text: Binding(get: { notes[project.projectId] ?? "" },
                                    set: { notes[project.projectId] = $0 }))
                .textFieldStyle(.roundedBorder)
            Toggle(L10n.projectNetwork,
                   isOn: Binding(get: { outboundProjectIds.contains(project.projectId) },
                                 set: { enabled in
                                    if enabled { outboundProjectIds.insert(project.projectId) }
                                    else { outboundProjectIds.remove(project.projectId) }
                                 }))
                .font(.system(size: 11, weight: .medium, design: .rounded))
            HStack(spacing: 10) {
                Button { Task { await checkpoint(project) } } label: {
                    Label(L10n.projectSave, systemImage: "archivebox")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(FloatingGlassButtonStyle())
                Button { Task { await publish(project) } } label: {
                    Label(L10n.projectPublish, systemImage: "iphone.and.arrow.forward")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(FloatingGlassButtonStyle())
            }
            .disabled(runtime.mutatingProjectIds.contains(project.projectId))
        }
        .padding(15)
        .background(Color.white.opacity(0.46), in: RoundedRectangle(cornerRadius: 18))
        .overlay(RoundedRectangle(cornerRadius: 18).stroke(Color.white.opacity(0.72), lineWidth: 0.7))
    }

    private func refresh() async {
        do {
            async let projectRefresh: Void = runtime.refreshProjects(collaboratorId: collaborator.id)
            async let surfaceRefresh: Void = runtime.refreshSurfaces(collaboratorId: collaborator.id)
            _ = try await (projectRefresh, surfaceRefresh)
            errorMessage = nil
        } catch { errorMessage = error.localizedDescription }
    }

    private func create() async {
        do {
            let trimmedRepository = repositoryURL.trimmingCharacters(in: .whitespacesAndNewlines)
            _ = try await runtime.createProject(
                collaboratorId: collaborator.id,
                title: title,
                repositoryURL: trimmedRepository.isEmpty ? nil : trimmedRepository,
                entryPath: entryPath)
            title = ""
            repositoryURL = ""
            entryPath = "index.html"
            successMessage = L10n.projectCreated
            errorMessage = nil
        } catch { errorMessage = error.localizedDescription }
    }

    private func checkpoint(_ project: HostCollaboratorProject) async {
        do {
            _ = try await runtime.checkpointProject(
                collaboratorId: collaborator.id,
                project: project,
                note: notes[project.projectId] ?? "")
            notes[project.projectId] = nil
            successMessage = L10n.projectSaved
            errorMessage = nil
        } catch { errorMessage = error.localizedDescription }
    }

    private func publish(_ project: HostCollaboratorProject) async {
        do {
            _ = try await runtime.publishProject(
                collaboratorId: collaborator.id,
                project: project,
                note: notes[project.projectId] ?? "",
                allowsOutboundNetwork: outboundProjectIds.contains(project.projectId))
            notes[project.projectId] = nil
            successMessage = L10n.projectPublishedNow
            errorMessage = nil
        } catch { errorMessage = error.localizedDescription }
    }

    private var projects: [HostCollaboratorProject] {
        (runtime.collaboratorProjects[collaborator.id] ?? []).filter { !$0.isArchived }
    }

    private var isCreating: Bool {
        runtime.mutatingProjectIds.contains("new::\(collaborator.id)")
    }
}
