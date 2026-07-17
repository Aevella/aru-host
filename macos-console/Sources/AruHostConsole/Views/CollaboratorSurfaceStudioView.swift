import SwiftUI
import WebKit

struct CollaboratorSurfaceStudioView: View {
    @ObservedObject var runtime: HostConsoleRuntime
    let collaborator: HostedCollaborator

    @Environment(\.dismiss) private var dismiss
    @State private var selectedSurfaceId: String?
    @State private var detail: HostCollaboratorSurface?
    @State private var title = ""
    @State private var sourceHTML = Self.defaultHTML
    @State private var versionNote = ""
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
        case cognition
        case surfaces

        var id: String { rawValue }
        var title: String {
            switch self {
            case .conversations: L10n.conversations
            case .cognition: L10n.cognition
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
                } else if studioPage == .cognition {
                    CollaboratorCognitionStudioView(runtime: runtime, collaborator: collaborator)
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
    }

    private var header: some View {
        HStack(spacing: 14) {
            StatusGlyph(state: .ready)
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
            .frame(width: 360)
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
        case .cognition: L10n.cognitionStudioSubtitle
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
                    Button {
                        Task { await refreshFromHost() }
                    } label: {
                        if isRefreshingInventory {
                            ProgressView().controlSize(.small)
                        } else {
                            Image(systemName: "arrow.clockwise")
                        }
                    }
                    .buttonStyle(StudioIconButtonStyle())
                    .disabled(isRefreshingInventory)
                    .help(L10n.refresh)

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
                StudioTextField(
                    placeholder: L10n.surfaceVersionNote,
                    text: $versionNote,
                    symbol: "text.quote",
                    weight: .regular)
                if let detail {
                    Button(detail.isArchived ? L10n.restore : L10n.archive) {
                        Task { await setArchived(!detail.isArchived) }
                    }
                    .buttonStyle(FloatingGlassButtonStyle(
                        tint: detail.isArchived ? HostPalette.mint.opacity(0.18) : HostPalette.rose.opacity(0.14)))
                }
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
        .padding(18)
        .background(Color.white.opacity(0.08))
    }

    @ViewBuilder
    private var editorBody: some View {
        switch editorPage {
        case .source:
            TextEditor(text: $sourceHTML)
                .font(.system(size: 12, design: .monospaced))
                .scrollContentBackground(.hidden)
                .padding(12)
                .background(Color.white.opacity(0.42),
                            in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 18).stroke(Color.white.opacity(0.55)))
        case .preview:
            HostSurfacePreview(html: sourceHTML)
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
        title = ""
        sourceHTML = Self.defaultHTML
        versionNote = ""
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
            versionNote = ""
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
            if let selectedSurfaceId,
               let selected = surfaces.first(where: { $0.surfaceId == selectedSurfaceId }) {
                await select(selected)
            }
        } catch {
            errorMessage = error.localizedDescription
        }
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
                note: versionNote)
            detail = value
            selectedSurfaceId = value.surfaceId
            versionNote = ""
            successMessage = L10n.surfacePublished
        } catch {
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

private struct StudioTextField: View {
    let placeholder: String
    @Binding var text: String
    let symbol: String
    let weight: Font.Weight

    @FocusState private var isFocused: Bool

    var body: some View {
        HStack(spacing: 9) {
            Image(systemName: symbol)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(isFocused
                                 ? HostPalette.lavenderDeep.opacity(0.82)
                                 : HostPalette.secondaryInk.opacity(0.42))
            TextField(placeholder, text: $text)
                .textFieldStyle(.plain)
                .font(.system(size: 13.5, weight: weight, design: .rounded))
                .foregroundStyle(HostPalette.ink)
                .focused($isFocused)
                .focusEffectDisabled()
        }
        .padding(.horizontal, 13)
        .frame(minHeight: 40)
        .background {
            RoundedRectangle(cornerRadius: 13, style: .continuous)
                .fill(Color.white.opacity(isFocused ? 0.44 : 0.30))
                .overlay {
                    RoundedRectangle(cornerRadius: 13, style: .continuous)
                        .stroke(
                            isFocused
                            ? HostPalette.lavender.opacity(0.34)
                            : Color.white.opacity(0.54),
                            lineWidth: isFocused ? 1.0 : 0.7)
                }
                .shadow(
                    color: isFocused
                    ? HostPalette.lavenderDeep.opacity(0.10)
                    : Color.clear,
                    radius: 10,
                    y: 4)
        }
        .animation(.easeOut(duration: 0.16), value: isFocused)
    }
}

struct StudioIconButtonStyle: ButtonStyle {
    var tint = Color.white.opacity(0.12)

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(HostPalette.ink.opacity(0.82))
            .frame(width: 34, height: 34)
            .background {
                Circle()
                    .fill(Color.white.opacity(configuration.isPressed ? 0.42 : 0.24))
                    .overlay {
                        Circle().fill(tint)
                    }
                    .overlay {
                        Circle().stroke(Color.white.opacity(0.62), lineWidth: 0.7)
                    }
                    .shadow(color: HostPalette.lavenderDeep.opacity(0.08), radius: 7, y: 3)
            }
            .scaleEffect(configuration.isPressed ? 0.94 : 1)
            .animation(.snappy(duration: 0.16), value: configuration.isPressed)
    }
}

private struct HostSurfacePreview: NSViewRepresentable {
    let html: String

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
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
        guard context.coordinator.loaded != html else { return }
        context.coordinator.loaded = html
        let policy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
        let meta = "<meta http-equiv=\"Content-Security-Policy\" content=\"\(policy)\">"
        webView.loadHTMLString(Self.inserting(meta: meta, into: html), baseURL: nil)
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator: NSObject, WKNavigationDelegate {
        var loaded = ""

        func webView(_ webView: WKWebView,
                     decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
            let scheme = navigationAction.request.url?.scheme?.lowercased()
            decisionHandler(scheme == "about" ? .allow : .cancel)
        }
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
