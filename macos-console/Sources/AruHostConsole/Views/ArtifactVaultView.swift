import SwiftUI

struct ArtifactVaultView: View {
    @ObservedObject var runtime: HostConsoleRuntime

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                HostSectionHeader(
                    title: L10n.artifacts,
                    subtitle: L10n.artifactsSubtitle,
                    isLoading: runtime.loadingSections.contains(.artifacts)
                ) {
                    Task { await runtime.refresh(.artifacts) }
                }
                if let error = runtime.sectionErrors[.artifacts] {
                    SectionErrorBanner(message: error)
                }

                HStack(spacing: 12) {
                    StatTile(label: L10n.remoteArtifacts, value: "\(runtime.artifacts.count)", detail: L10n.verifiedBySHA)
                    StatTile(label: L10n.totalStorage, value: HostFormat.bytes(totalBytes), detail: L10n.returnToPhone)
                }

                if runtime.artifacts.isEmpty {
                    EmptySectionState(
                        symbol: "shippingbox",
                        title: L10n.noArtifacts,
                        detail: L10n.noArtifactsDetail
                    )
                } else {
                    VStack(spacing: 12) {
                        ForEach(runtime.artifacts) { artifact in
                            ArtifactRow(artifact: artifact)
                        }
                    }
                }
            }
            .padding(30)
        }
    }

    private var totalBytes: Int64 {
        runtime.artifacts.reduce(0) { $0 + $1.byteCount }
    }
}

private struct ArtifactRow: View {
    let artifact: HostArtifact

    var body: some View {
        ReadablePanel {
            HStack(spacing: 16) {
                StatusGlyph(state: .ready)
                VStack(alignment: .leading, spacing: 4) {
                    Text(artifact.filename)
                        .font(.system(size: 14, weight: .semibold, design: .rounded))
                        .foregroundStyle(HostPalette.ink)
                    Text("\(artifact.mimeType) · \(HostFormat.date(artifact.createdAt))")
                        .font(.system(size: 10, design: .rounded))
                        .foregroundStyle(HostPalette.secondaryInk.opacity(0.62))
                }
                Spacer()
                Text(HostFormat.bytes(artifact.byteCount))
                    .font(.system(size: 11, weight: .semibold, design: .rounded))
                    .foregroundStyle(HostPalette.secondaryInk)
            }
        }
    }
}
