import SwiftUI

struct WorkspaceRuntimeView: View {
    @ObservedObject var runtime: HostConsoleRuntime
    @State private var presentsPolicy = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                HostSectionHeader(
                    title: L10n.runtime,
                    subtitle: L10n.runtimeSubtitle,
                    isLoading: runtime.loadingSections.contains(.runtime)
                ) {
                    Task { await runtime.refresh(.runtime) }
                }
                if let error = runtime.sectionErrors[.runtime] {
                    SectionErrorBanner(message: error)
                }

                runtimeSummary
                policyPanel

                if runtime.jobs.isEmpty {
                    EmptySectionState(
                        symbol: "terminal",
                        title: L10n.noJobs,
                        detail: runtime.capability("job-runtime")?.enabled == true
                            ? L10n.noJobsDetail
                            : L10n.noContainerRuntimeDetail
                    )
                } else {
                    VStack(alignment: .leading, spacing: 12) {
                        Text(L10n.jobLedger)
                            .font(.system(size: 16, weight: .semibold, design: .rounded))
                            .foregroundStyle(HostPalette.ink)
                        ForEach(runtime.jobs) { job in
                            JobRow(job: job)
                        }
                    }
                }
            }
            .padding(30)
        }
        .sheet(isPresented: $presentsPolicy) {
            JobPolicySheet(runtime: runtime)
        }
    }

    private var runtimeSummary: some View {
        ReadablePanel {
            HStack(spacing: 16) {
                StatusGlyph(state: runtime.capability("workspace-runtime")?.enabled == true ? .ready : .waiting)
                VStack(alignment: .leading, spacing: 5) {
                    Text(L10n.workspaceRuntime)
                        .font(.system(size: 16, weight: .semibold, design: .rounded))
                        .foregroundStyle(HostPalette.ink)
                    Text(runtime.capability("workspace-runtime")?.enabled == true
                         ? L10n.runtimeReadyDescription
                         : L10n.containerRuntimeMissingDescription)
                        .font(.system(size: 11, design: .rounded))
                        .foregroundStyle(HostPalette.secondaryInk.opacity(0.64))
                }
                Spacer()
                HStack(spacing: 7) {
                    ForEach(runtime.capability("workspace-runtime")?.runtimes ?? [], id: \.self) { item in
                        Text(item)
                            .font(.system(size: 10, weight: .medium, design: .monospaced))
                            .padding(.horizontal, 9)
                            .padding(.vertical, 6)
                            .background(Capsule().fill(Color.white.opacity(0.22)))
                    }
                }
            }
        }
    }

    private var policyPanel: some View {
        ReadablePanel {
            HStack(spacing: 16) {
                Image(systemName: "timer")
                    .font(.system(size: 23, weight: .light))
                    .foregroundStyle(HostPalette.lavenderDeep)
                    .frame(width: 34)
                VStack(alignment: .leading, spacing: 5) {
                    Text(L10n.defaultJobBudget)
                        .font(.system(size: 14, weight: .semibold, design: .rounded))
                        .foregroundStyle(HostPalette.ink)
                    Text(L10n.jobBudgetDescription)
                        .font(.system(size: 10, design: .rounded))
                        .foregroundStyle(HostPalette.secondaryInk.opacity(0.62))
                }
                Spacer()
                Text(HostFormat.duration(runtime.jobPolicy?.defaultMaximumRuntimeSeconds))
                    .font(.system(size: 15, weight: .semibold, design: .rounded))
                    .foregroundStyle(HostPalette.ink)
                Button(L10n.change) { presentsPolicy = true }
                    .buttonStyle(FloatingGlassButtonStyle())
            }
        }
    }
}

private struct JobRow: View {
    let job: HostWorkspaceJob

    var body: some View {
        ReadablePanel {
            HStack(spacing: 16) {
                StatusGlyph(state: stateGlyph)
                VStack(alignment: .leading, spacing: 4) {
                    Text(job.projectId)
                        .font(.system(size: 14, weight: .semibold, design: .rounded))
                        .foregroundStyle(HostPalette.ink)
                    Text("\(job.runtime) · \(HostFormat.date(job.queuedAt))")
                        .font(.system(size: 10, design: .rounded))
                        .foregroundStyle(HostPalette.secondaryInk.opacity(0.62))
                }
                Spacer()
                Text(job.state)
                    .font(.system(size: 11, weight: .semibold, design: .monospaced))
                    .foregroundStyle(stateGlyph == .ready ? HostPalette.mint : HostPalette.amber)
            }
        }
    }

    private var stateGlyph: StatusGlyph.State {
        switch job.state {
        case "succeeded": .ready
        case "failed", "timed_out": .unavailable
        default: .waiting
        }
    }
}

private struct JobPolicySheet: View {
    @ObservedObject var runtime: HostConsoleRuntime
    @Environment(\.dismiss) private var dismiss
    @State private var unlimited: Bool
    @State private var hours: String
    @State private var errorMessage: String?

    init(runtime: HostConsoleRuntime) {
        self.runtime = runtime
        let seconds = runtime.jobPolicy?.defaultMaximumRuntimeSeconds
        _unlimited = State(initialValue: seconds == nil)
        _hours = State(initialValue: seconds.map { String(max(1, $0 / 3_600)) } ?? "24")
    }

    var body: some View {
        ZStack {
            BorrowedLightWeather()
            VStack(alignment: .leading, spacing: 22) {
                VStack(alignment: .leading, spacing: 7) {
                    Text(L10n.defaultJobBudget)
                        .font(.system(size: 25, weight: .light, design: .rounded))
                        .foregroundStyle(HostPalette.ink)
                    Text(L10n.jobPolicySheetDescription)
                        .font(.system(size: 12, design: .rounded))
                        .foregroundStyle(HostPalette.secondaryInk.opacity(0.70))
                }

                Toggle(L10n.unlimited, isOn: $unlimited)
                    .toggleStyle(.switch)

                if !unlimited {
                    HStack {
                        Text(L10n.maximumHours)
                            .font(.system(size: 13, weight: .medium, design: .rounded))
                        Spacer()
                        TextField("24", text: $hours)
                            .textFieldStyle(.roundedBorder)
                            .frame(width: 100)
                    }
                }

                if let errorMessage {
                    Text(errorMessage)
                        .font(.system(size: 11, design: .rounded))
                        .foregroundStyle(HostPalette.rose)
                }

                HStack {
                    Button(L10n.cancel) { dismiss() }
                        .buttonStyle(FloatingGlassButtonStyle())
                    Spacer()
                    Button(L10n.saveSettings) {
                        Task {
                            do {
                                try await runtime.updateJobPolicy(maximumRuntimeSeconds: secondsValue)
                                dismiss()
                            } catch {
                                errorMessage = error.localizedDescription
                            }
                        }
                    }
                    .buttonStyle(FloatingGlassButtonStyle(tint: HostPalette.lavender.opacity(0.28)))
                    .disabled(!isValid || runtime.isUpdatingJobPolicy)
                }
            }
            .padding(30)
            .background {
                RoundedRectangle(cornerRadius: 34, style: .continuous)
                    .fill(Color.white.opacity(0.28))
                    .glassEffect(.regular.tint(Color.white.opacity(0.12)), in: RoundedRectangle(cornerRadius: 34))
            }
            .padding(18)
        }
        .frame(width: 480, height: 390)
        .preferredColorScheme(.light)
    }

    private var parsedHours: Int64? { Int64(hours.trimmingCharacters(in: .whitespaces)) }

    private var secondsValue: Int64? {
        guard !unlimited, let parsedHours else { return nil }
        let result = parsedHours.multipliedReportingOverflow(by: 3_600)
        return result.overflow ? nil : result.partialValue
    }

    private var isValid: Bool {
        unlimited || (parsedHours ?? 0) > 0 && secondsValue != nil
    }
}
