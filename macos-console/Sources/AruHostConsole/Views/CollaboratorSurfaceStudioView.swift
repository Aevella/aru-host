import SwiftUI
import WebKit

struct CollaboratorSurfaceStudioView: View {
    let runtime: HostConsoleRuntime
    let collaborator: HostedCollaborator

    @Environment(\.dismiss) private var dismiss
    @State private var selectedSurfaceId: String?
    @State private var detail: HostCollaboratorSurface?
    @State private var surfaceBundle: HostCollaboratorSurfaceBundle?
    @State private var title = ""
    @State private var sourceHTML = Self.defaultHTML
    @State private var versionNote = ""
    @State private var allowsOutboundNetwork = false
    @State private var editorPage = EditorPage.source
    @State private var isLoadingDetail = false
    @State private var isRefreshingInventory = false
    @State private var errorMessage: String?
    @State private var successMessage: String?
    @State private var studioPage = StudioPage.conversations
    @Namespace private var editorPageSelection
    @Namespace private var studioPageSelection

    private enum EditorPage: String, CaseIterable, Identifiable {
        case source
        case preview
        case versions
        case state

        var id: String { rawValue }

        var title: String {
            switch self {
            case .source: L10n.surfaceSource
            case .preview: L10n.surfacePreview
            case .versions: L10n.surfaceVersions
            case .state: L10n.surfaceState
            }
        }
    }

    private enum StudioPage: String, CaseIterable, Identifiable {
        case conversations
        case initiative
        case cognition
        case projects
        case surfaces

        var id: String { rawValue }
        var title: String {
            switch self {
            case .conversations: L10n.conversations
            case .initiative: L10n.initiative
            case .cognition: L10n.cognition
            case .projects: L10n.projects
            case .surfaces: L10n.surfaces
            }
        }
    }

    var body: some View {
        ZStack {
            BorrowedLightWeather()
            VStack(spacing: 0) {
                header
                Divider().overlay(Color.white.opacity(0.48))
                if studioPage == .conversations {
                    CollaboratorConversationStudioView(runtime: runtime, collaborator: collaborator)
                } else if studioPage == .initiative {
                    CollaboratorInitiativeStudioView(runtime: runtime, collaborator: collaborator)
                } else if studioPage == .cognition {
                    CollaboratorCognitionStudioView(runtime: runtime, collaborator: collaborator)
                } else if studioPage == .projects {
                    CollaboratorProjectStudioView(runtime: runtime, collaborator: collaborator)
                } else {
                    HStack(spacing: 0) {
                        surfaceDirectory
                            .frame(width: 270)
                        Divider().overlay(Color.white.opacity(0.48))
                        editor
                    }
                }
            }
            .padding(18)
        }
        .frame(minWidth: 1020, minHeight: 700)
        .preferredColorScheme(.light)
        .task {
            if let first = surfaces.first(where: { !$0.isArchived }) ?? surfaces.first {
                await select(first)
            } else {
                beginNewSurface()
            }
        }
        .task(id: studioPage) {
            guard studioPage == .surfaces else { return }
            while !Task.isCancelled {
                await refreshFromHost()
                try? await Task.sleep(for: .seconds(8))
            }
        }
    }

    private var header: some View {
        HStack(spacing: 14) {
            HostedCollaboratorAvatar(
                collaborator: collaborator,
                size: 44,
                statusColor: collaborator.turnExecution ? HostPalette.mint : HostPalette.amber
            )
            VStack(alignment: .leading, spacing: 3) {
                Text(collaborator.displayName)
                    .font(.system(size: 23, weight: .light, design: .rounded))
                    .foregroundStyle(HostPalette.ink)
                Text(studioSubtitle)
                    .font(.system(size: 11, design: .rounded))
                    .foregroundStyle(HostPalette.secondaryInk.opacity(0.68))
            }
            Spacer()
            HStack(spacing: 3) {
                ForEach(StudioPage.allCases) { page in
                    Button {
                        withAnimation(.snappy(duration: 0.24)) { studioPage = page }
                    } label: {
                        Text(page.title)
                            .font(.system(size: 12, weight: studioPage == page ? .semibold : .medium,
                                          design: .rounded))
                            .foregroundStyle(studioPage == page
                                             ? HostPalette.lavenderDeep
                                             : HostPalette.secondaryInk.opacity(0.72))
                            .frame(maxWidth: .infinity)
                            .frame(height: 32)
                            .contentShape(Capsule())
                            .background {
                                if studioPage == page {
                                    Capsule()
                                        .fill(Color.white.opacity(0.58))
                                        .overlay(Capsule().stroke(Color.white.opacity(0.80), lineWidth: 0.7))
                                        .shadow(color: HostPalette.lavenderDeep.opacity(0.11), radius: 8, y: 3)
                                        .matchedGeometryEffect(id: "collaborator-studio-page",
                                                               in: studioPageSelection)
                                }
                            }
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(4)
            .frame(width: 560)
            .background {
                Capsule()
                    .fill(Color.white.opacity(0.18))
                    .overlay(Capsule().stroke(Color.white.opacity(0.48), lineWidth: 0.7))
            }
            if let successMessage {
                Label(successMessage, systemImage: "checkmark.circle.fill")
                    .font(.system(size: 11, weight: .medium, design: .rounded))
                    .foregroundStyle(HostPalette.mint)
            }
            Button(L10n.close) { dismiss() }
                .buttonStyle(FloatingGlassButtonStyle())
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 15)
    }

    private var studioSubtitle: String {
        switch studioPage {
        case .conversations: L10n.conversationStudioSubtitle
        case .initiative: L10n.initiativeStudioSubtitle
        case .cognition: L10n.cognitionStudioSubtitle
        case .projects: L10n.projectStudioSubtitle
        case .surfaces: L10n.surfaceStudioSubtitle
        }
    }

    private var surfaceDirectory: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text(L10n.surfaces)
                    .font(.system(size: 15, weight: .semibold, design: .rounded))
                    .foregroundStyle(HostPalette.ink)
                Spacer()
                HStack(spacing: 7) {
                    Button(action: beginNewSurface) {
                        Image(systemName: "plus")
                    }
                    .buttonStyle(StudioIconButtonStyle(tint: HostPalette.lavender.opacity(0.18)))
                }
            }

            if surfaces.isEmpty {
                VStack(alignment: .leading, spacing: 7) {
                    Image(systemName: "sparkles.rectangle.stack")
                        .font(.system(size: 24, weight: .light))
                        .foregroundStyle(HostPalette.lavender)
                    Text(L10n.noSurfaces)
                        .font(.system(size: 13, weight: .semibold, design: .rounded))
                    Text(L10n.noSurfacesDetail)
                        .font(.system(size: 11, design: .rounded))
                        .foregroundStyle(HostPalette.secondaryInk.opacity(0.66))
                }
                .padding(.vertical, 18)
            } else {
                ScrollView {
                    LazyVStack(spacing: 8) {
                        ForEach(surfaces) { surface in
                            Button {
                                Task { await select(surface) }
                            } label: {
                                HStack(spacing: 10) {
                                    Image(systemName: surface.isArchived
                                          ? "rectangle.slash"
                                          : "sparkles.rectangle.stack")
                                        .foregroundStyle(surface.isArchived
                                                         ? HostPalette.secondaryInk.opacity(0.4)
                                                         : HostPalette.lavender)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(surface.title)
                                            .font(.system(size: 12.5, weight: .semibold, design: .rounded))
                                            .foregroundStyle(HostPalette.ink)
                                            .lineLimit(2)
                                        Text(L10n.surfaceVersion(surface.activeVersionOrdinal))
                                            .font(.system(size: 10, design: .rounded))
                                            .foregroundStyle(HostPalette.secondaryInk.opacity(0.58))
                                    }
                                    Spacer()
                                }
                                .padding(10)
                                .background(
                                    selectedSurfaceId == surface.surfaceId
                                    ? HostPalette.lavender.opacity(0.16)
                                    : Color.white.opacity(0.18),
                                    in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
            Spacer()
            Text(L10n.surfaceAuthorityDescription)
                .font(.system(size: 10.5, design: .rounded))
                .foregroundStyle(HostPalette.secondaryInk.opacity(0.58))
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(16)
        .background(Color.white.opacity(0.10))
    }

    private var editor: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 12) {
                StudioTextField(
                    placeholder: L10n.surfaceTitle,
                    text: $title,
                    symbol: "textformat",
                    weight: .semibold)
                    .disabled(isProjectSurface)
                HStack(spacing: 3) {
                    ForEach(EditorPage.allCases) { page in
                        Button {
                            withAnimation(.snappy(duration: 0.24)) {
                                editorPage = page
                            }
                        } label: {
                            Text(page.title)
                                .font(.system(size: 12, weight: editorPage == page ? .semibold : .medium,
                                              design: .rounded))
                                .foregroundStyle(editorPage == page
                                                 ? HostPalette.lavenderDeep
                                                 : HostPalette.secondaryInk.opacity(0.74))
                                .frame(maxWidth: .infinity)
                                .frame(height: 32)
                                .contentShape(Capsule())
                                .background {
                                    if editorPage == page {
                                        Capsule()
                                            .fill(Color.white.opacity(0.56))
                                            .overlay {
                                                Capsule()
                                                    .stroke(Color.white.opacity(0.80), lineWidth: 0.7)
                                            }
                                            .shadow(color: HostPalette.lavenderDeep.opacity(0.12),
                                                    radius: 8, y: 3)
                                            .matchedGeometryEffect(
                                                id: "surface-editor-page",
                                                in: editorPageSelection)
                                    }
                                }
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(4)
                .frame(width: 390)
                .background {
                    Capsule()
                        .fill(Color.white.opacity(0.18))
                        .overlay {
                            Capsule().stroke(Color.white.opacity(0.48), lineWidth: 0.7)
                        }
                }
            }

            if let errorMessage {
                SectionErrorBanner(message: errorMessage)
            }

            runtimeControls

            Group {
                if isLoadingDetail {
                    VStack { Spacer(); ProgressView(); Spacer() }
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    editorBody
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            HStack(spacing: 12) {
                if isProjectSurface {
                    Label(L10n.surfaceProjectDetail, systemImage: "shippingbox.fill")
                        .font(.system(size: 10.5, design: .rounded))
                        .foregroundStyle(HostPalette.secondaryInk.opacity(0.64))
                        .lineLimit(2)
                } else {
                    StudioTextField(
                        placeholder: L10n.surfaceVersionNote,
                        text: $versionNote,
                        symbol: "text.quote",
                        weight: .regular)
                }
                Spacer(minLength: 0)
                if let detail {
                    Button(detail.isArchived ? L10n.restore : L10n.archive) {
                        Task { await setArchived(!detail.isArchived) }
                    }
                    .buttonStyle(FloatingGlassButtonStyle(
                        tint: detail.isArchived ? HostPalette.mint.opacity(0.18) : HostPalette.rose.opacity(0.14)))
                }
                if !isProjectSurface {
                    Button {
                        Task { await save() }
                    } label: {
                        HStack(spacing: 7) {
                            if isMutating { ProgressView().controlSize(.small) }
                            Text(detail == nil ? L10n.publishSurface : L10n.publishVersion)
                        }
                    }
                    .buttonStyle(FloatingGlassButtonStyle(tint: HostPalette.lavender.opacity(0.28)))
                    .disabled(title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                              || sourceHTML.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                              || isMutating
                              || detail?.isArchived == true)
                }
            }
        }
        .padding(18)
        .background(Color.white.opacity(0.08))
    }

    @ViewBuilder
    private var editorBody: some View {
        switch editorPage {
        case .source:
            if isProjectSurface {
                projectManifestView
            } else {
                TextEditor(text: $sourceHTML)
                    .font(.system(size: 12, design: .monospaced))
                    .scrollContentBackground(.hidden)
                    .padding(12)
                    .background(Color.white.opacity(0.42),
                                in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 18).stroke(Color.white.opacity(0.55)))
            }
        case .preview:
            HostSurfacePreview(html: sourceHTML,
                               bundle: surfaceBundle,
                               surfaceId: detail?.surfaceId,
                               allowsOutboundNetwork: allowsOutboundNetwork)
                .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 18).stroke(Color.white.opacity(0.55)))
        case .versions:
            versionsView
        case .state:
            ScrollView {
                Text(prettyState)
                    .font(.system(size: 12, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(14)
            }
            .background(Color.white.opacity(0.42),
                        in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        }
    }

    private var runtimeControls: some View {
        HStack(spacing: 12) {
            Label(L10n.surfacePersistentStorage, systemImage: "externaldrive.badge.checkmark")
                .font(.system(size: 10.5, weight: .semibold, design: .rounded))
                .foregroundStyle(HostPalette.mint)
            Text(L10n.surfacePersistentStorageDetail)
                .font(.system(size: 10, design: .rounded))
                .foregroundStyle(HostPalette.secondaryInk.opacity(0.62))
                .lineLimit(1)
            Spacer()
            Toggle(L10n.surfaceNetworkAccess, isOn: Binding(
                get: { allowsOutboundNetwork },
                set: { value in
                    allowsOutboundNetwork = value
                    if detail != nil {
                        Task { await setNetworkAccess(value) }
                    }
                }))
                .toggleStyle(.switch)
                .controlSize(.small)
                .font(.system(size: 10.5, weight: .semibold, design: .rounded))
                .disabled(isMutating)
                .help(L10n.surfaceNetworkAccessDetail)
        }
        .padding(.horizontal, 12)
        .frame(minHeight: 38)
        .background(Color.white.opacity(0.24),
                    in: RoundedRectangle(cornerRadius: 13, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 13).stroke(Color.white.opacity(0.48), lineWidth: 0.7))
    }

    private var projectManifestView: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Label(L10n.surfaceProject, systemImage: "folder.badge.gearshape")
                    .font(.system(size: 15, weight: .semibold, design: .rounded))
                    .foregroundStyle(HostPalette.ink)
                Text(L10n.surfaceProjectDetail)
                    .font(.system(size: 11.5, design: .rounded))
                    .foregroundStyle(HostPalette.secondaryInk.opacity(0.68))
                HStack(spacing: 10) {
                    projectFact(L10n.surfaceProjectEntry, value: detail?.entryPath ?? "—")
                    projectFact(L10n.surfaceProjectFiles, value: "\(detail?.files?.count ?? 0)")
                    projectFact(L10n.surfaceProjectBytes,
                                value: ByteCountFormatter.string(fromByteCount: Int64(detail?.byteCount ?? 0),
                                                                 countStyle: .file))
                }
                LazyVStack(spacing: 7) {
                    ForEach(detail?.files ?? []) { file in
                        HStack(spacing: 10) {
                            Image(systemName: "doc")
                                .foregroundStyle(HostPalette.lavender)
                            Text(file.path)
                                .font(.system(size: 11.5, design: .monospaced))
                                .foregroundStyle(HostPalette.ink)
                            Spacer()
                            Text(ByteCountFormatter.string(fromByteCount: Int64(file.byteCount), countStyle: .file))
                                .font(.system(size: 10.5, design: .rounded))
                                .foregroundStyle(HostPalette.secondaryInk.opacity(0.58))
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 9)
                        .background(Color.white.opacity(0.24),
                                    in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16)
        }
        .background(Color.white.opacity(0.42),
                    in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 18).stroke(Color.white.opacity(0.55)))
    }

    private func projectFact(_ label: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label)
                .font(.system(size: 9.5, weight: .medium, design: .rounded))
                .foregroundStyle(HostPalette.secondaryInk.opacity(0.55))
            Text(value)
                .font(.system(size: 11, weight: .semibold, design: .rounded))
                .foregroundStyle(HostPalette.ink)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
        .background(Color.white.opacity(0.28), in: RoundedRectangle(cornerRadius: 12))
    }

    private var versionsView: some View {
        ScrollView {
            LazyVStack(spacing: 9) {
                ForEach(surfaceVersions) { version in
                    versionRow(version)
                }
            }
        }
    }

    private var surfaceVersions: [HostCollaboratorSurfaceVersion] {
        detail?.versions ?? []
    }

    private func versionRow(_ version: HostCollaboratorSurfaceVersion) -> some View {
        let isCurrent = version.versionId == detail?.activeVersionId
        let detailText = version.note.isEmpty
            ? String(version.contentSHA256.prefix(12))
            : version.note

        return HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 7) {
                    Text(L10n.surfaceVersion(version.ordinal))
                        .font(.system(size: 13, weight: .semibold, design: .rounded))
                    if isCurrent {
                        Text(L10n.current)
                            .font(.system(size: 9.5, weight: .bold, design: .rounded))
                            .foregroundStyle(HostPalette.lavender)
                    }
                }
                Text(detailText)
                    .font(.system(size: 10.5, design: .rounded))
                    .foregroundStyle(HostPalette.secondaryInk.opacity(0.62))
            }
            Spacer()
            if !isCurrent {
                Button(L10n.surfaceRollbackAction) {
                    Task { await rollback(to: version.versionId) }
                }
                .buttonStyle(FloatingGlassButtonStyle())
                .disabled(isMutating)
            }
        }
        .padding(12)
        .background(Color.white.opacity(0.30),
                    in: RoundedRectangle(cornerRadius: 15, style: .continuous))
    }

    private var surfaces: [HostCollaboratorSurface] {
        runtime.collaboratorSurfaces[collaborator.id] ?? []
    }

    private var isMutating: Bool {
        runtime.mutatingSurfaceIds.contains(detail?.surfaceId ?? "new::\(collaborator.id)")
    }

    private var isProjectSurface: Bool { detail?.delivery == "bundle" }

    private var prettyState: String {
        guard let value = detail?.stateJSON,
              let data = value.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data),
              let pretty = try? JSONSerialization.data(withJSONObject: object,
                                                        options: [.prettyPrinted, .sortedKeys]),
              let result = String(data: pretty, encoding: .utf8) else {
            return detail?.stateJSON ?? "{}"
        }
        return result
    }

    private func beginNewSurface() {
        selectedSurfaceId = nil
        detail = nil
        surfaceBundle = nil
        title = ""
        sourceHTML = Self.defaultHTML
        versionNote = ""
        allowsOutboundNetwork = false
        errorMessage = nil
        successMessage = nil
        editorPage = .source
    }

    private func select(_ surface: HostCollaboratorSurface) async {
        selectedSurfaceId = surface.surfaceId
        isLoadingDetail = true
        errorMessage = nil
        defer { isLoadingDetail = false }
        do {
            let value = try await runtime.surfaceDetail(
                collaboratorId: collaborator.id, surfaceId: surface.surfaceId)
            detail = value
            title = value.title
            sourceHTML = value.sourceHTML ?? ""
            allowsOutboundNetwork = value.allowsOutboundNetwork
            versionNote = ""
            surfaceBundle = nil
            if value.delivery == "bundle" {
                surfaceBundle = try await runtime.surfaceBundle(
                    collaboratorId: collaborator.id,
                    surfaceId: value.surfaceId,
                    versionId: value.activeVersionId)
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func refreshFromHost() async {
        guard !isRefreshingInventory else { return }
        isRefreshingInventory = true
        errorMessage = nil
        defer { isRefreshingInventory = false }
        do {
            try await runtime.refreshSurfaces(collaboratorId: collaborator.id)
            if !hasEditorChanges,
               let selectedSurfaceId,
               let selected = surfaces.first(where: { $0.surfaceId == selectedSurfaceId }) {
                await select(selected)
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private var hasEditorChanges: Bool {
        guard let detail else { return false }
        return title != detail.title
            || sourceHTML != (detail.sourceHTML ?? "")
            || allowsOutboundNetwork != detail.allowsOutboundNetwork
            || !versionNote.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func save() async {
        errorMessage = nil
        successMessage = nil
        do {
            let value = try await runtime.publishSurface(
                collaborator: collaborator,
                surface: detail,
                title: title,
                sourceHTML: sourceHTML,
                note: versionNote,
                allowsOutboundNetwork: allowsOutboundNetwork)
            detail = value
            selectedSurfaceId = value.surfaceId
            versionNote = ""
            successMessage = L10n.surfacePublished
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func setNetworkAccess(_ enabled: Bool) async {
        guard let detail else { return }
        errorMessage = nil
        do {
            let value = try await runtime.setSurfaceNetworkAccess(
                enabled, collaborator: collaborator, surface: detail)
            self.detail = value
            allowsOutboundNetwork = value.allowsOutboundNetwork
            successMessage = L10n.surfaceRuntimeSaved
        } catch {
            allowsOutboundNetwork = detail.allowsOutboundNetwork
            errorMessage = error.localizedDescription
        }
    }

    private func rollback(to versionId: String) async {
        guard let detail else { return }
        errorMessage = nil
        do {
            let value = try await runtime.rollbackSurface(
                collaborator: collaborator, surface: detail, versionId: versionId)
            self.detail = value
            sourceHTML = value.sourceHTML ?? sourceHTML
            surfaceBundle = nil
            if value.delivery == "bundle" {
                surfaceBundle = try await runtime.surfaceBundle(
                    collaboratorId: collaborator.id,
                    surfaceId: value.surfaceId,
                    versionId: value.activeVersionId)
            }
            successMessage = L10n.surfaceRolledBack
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func setArchived(_ archived: Bool) async {
        guard let detail else { return }
        errorMessage = nil
        do {
            let value = try await runtime.setSurfaceArchived(
                archived, collaborator: collaborator, surface: detail)
            self.detail = value
            successMessage = archived ? L10n.surfaceArchived : L10n.surfaceRestored
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private static let defaultHTML = """
    <!doctype html>
    <html lang="zh-CN">
    <head>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        :root { color-scheme: light dark; font-family: -apple-system, sans-serif; }
        body { margin: 0; min-height: 100vh; display: grid; place-items: center;
               background: linear-gradient(145deg, #eee8ff, #fff1f7); color: #24202d; }
        main { width: min(82vw, 520px); padding: 28px; border-radius: 28px;
               background: rgba(255,255,255,.58); box-shadow: 0 18px 60px rgba(77,54,112,.16); }
        button { border: 0; border-radius: 999px; padding: 12px 18px; background: #8d5cff; color: white; }
      </style>
    </head>
    <body>
      <main>
        <h1>这是我的页面</h1>
        <p>电脑协作者可以直接改写这里，并把每一个版本送到手机。</p>
        <button onclick="PolarisRoom.emit('hello', { at: Date.now() })">和我打个招呼</button>
      </main>
    </body>
    </html>
    """
}

private struct HostSurfacePreview: NSViewRepresentable {
    let html: String
    let bundle: HostCollaboratorSurfaceBundle?
    let surfaceId: String?
    let allowsOutboundNetwork: Bool

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = websiteDataStoreIdentifier.map {
            WKWebsiteDataStore(forIdentifier: $0)
        } ?? .nonPersistent()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.setURLSchemeHandler(context.coordinator, forURLScheme: Coordinator.scheme)
        configuration.userContentController.addUserScript(WKUserScript(
            source: "window.PolarisRoom={emit:function(){return true;},getState:function(){return {};},saveState:function(){return true;}};",
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true))
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        view.setValue(false, forKey: "drawsBackground")
        return view
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        let identity = "\(bundle?.contentSHA256 ?? html)::\(allowsOutboundNetwork)"
        guard context.coordinator.loaded != identity else { return }
        context.coordinator.loaded = identity
        context.coordinator.allowsOutboundNetwork = allowsOutboundNetwork
        context.coordinator.install(bundle: bundle)
        let policy = Self.contentPolicy(bundleAssetsAvailable: bundle != nil,
                                        allowsOutboundNetwork: allowsOutboundNetwork)
        let meta = "<meta http-equiv=\"Content-Security-Policy\" content=\"\(policy)\">"
        if let bundle,
           let entry = bundle.files.first(where: { $0.path == bundle.entryPath })?.data,
           let entryHTML = String(data: entry, encoding: .utf8),
           let baseURL = URL(string: "\(Coordinator.scheme)://bundle/\(bundle.entryPath)") {
            webView.loadHTMLString(Self.inserting(meta: meta, into: entryHTML), baseURL: baseURL)
        } else {
            webView.loadHTMLString(
                Self.inserting(meta: meta, into: html),
                baseURL: URL(string: "https://surface.aru.invalid/"))
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator: NSObject, WKNavigationDelegate, WKURLSchemeHandler {
        private struct Resource {
            let mimeType: String
            let data: Data
        }

        static let scheme = "aru-host-surface"
        var loaded = ""
        var allowsOutboundNetwork = false
        private var resources: [String: Resource] = [:]

        func install(bundle: HostCollaboratorSurfaceBundle?) {
            resources = Dictionary(uniqueKeysWithValues: (bundle?.files ?? []).compactMap { file in
                guard var data = file.data else { return nil }
                if file.mimeType == "text/html", let html = String(data: data, encoding: .utf8) {
                    let meta = "<meta http-equiv=\"Content-Security-Policy\" content=\"\(HostSurfacePreview.contentPolicy(bundleAssetsAvailable: true, allowsOutboundNetwork: allowsOutboundNetwork))\">"
                    data = Data(HostSurfacePreview.inserting(meta: meta, into: html).utf8)
                }
                return (file.path, Resource(mimeType: file.mimeType, data: data))
            })
        }

        func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
            guard let url = urlSchemeTask.request.url else {
                urlSchemeTask.didFailWithError(URLError(.badURL))
                return
            }
            let path = url.path.removingPercentEncoding?.trimmingCharacters(in: CharacterSet(charactersIn: "/")) ?? ""
            guard let file = resources[path] else {
                urlSchemeTask.didFailWithError(URLError(.fileDoesNotExist))
                return
            }
            let response = URLResponse(url: url,
                                       mimeType: file.mimeType,
                                       expectedContentLength: file.data.count,
                                       textEncodingName: file.mimeType.hasPrefix("text/") ? "utf-8" : nil)
            urlSchemeTask.didReceive(response)
            urlSchemeTask.didReceive(file.data)
            urlSchemeTask.didFinish()
        }

        func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}

        func webView(_ webView: WKWebView,
                     decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
            let scheme = navigationAction.request.url?.scheme?.lowercased()
            let local = scheme == "about" || scheme == Self.scheme || scheme == "data" || scheme == "blob"
            let remote = scheme == "https" || scheme == "http"
            decisionHandler(local || (allowsOutboundNetwork && remote) ? .allow : .cancel)
        }
    }

    private static func contentPolicy(bundleAssetsAvailable: Bool,
                                      allowsOutboundNetwork: Bool) -> String {
        let local = bundleAssetsAvailable ? " aru-host-surface:" : ""
        let localOnly = local.isEmpty ? " 'none'" : local
        if allowsOutboundNetwork {
            return "default-src https: http: data: blob:\(local); script-src 'unsafe-inline' 'unsafe-eval' https: http: data: blob:\(local); style-src 'unsafe-inline' https: http: data: blob:\(local); img-src https: http: data: blob:\(local); font-src https: http: data: blob:\(local); media-src https: http: data: blob:\(local); connect-src https: http: wss: ws:\(local); worker-src blob: data:\(local); manifest-src https: http:\(local); frame-src https: http:; object-src 'none'; base-uri 'none'"
        }
        return "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'\(local); style-src 'unsafe-inline'\(local); img-src data: blob:\(local); font-src data:\(local); media-src blob:\(local); connect-src\(localOnly); worker-src blob: data:\(local); manifest-src\(localOnly); frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
    }

    private var websiteDataStoreIdentifier: UUID? {
        guard let surfaceId else { return nil }
        return UUID(uuidString: surfaceId.replacingOccurrences(of: "surface_", with: ""))
    }

    private static func inserting(meta: String, into html: String) -> String {
        if let head = html.range(of: "<head", options: [.caseInsensitive]),
           let close = html[head.lowerBound...].firstIndex(of: ">") {
            let insertion = html.index(after: close)
            var result = html
            result.insert(contentsOf: meta, at: insertion)
            return result
        }
        if let htmlTag = html.range(of: "<html", options: [.caseInsensitive]),
           let close = html[htmlTag.lowerBound...].firstIndex(of: ">") {
            let insertion = html.index(after: close)
            var result = html
            result.insert(contentsOf: "<head>\(meta)</head>", at: insertion)
            return result
        }
        return "<head>\(meta)</head>\(html)"
    }
}
