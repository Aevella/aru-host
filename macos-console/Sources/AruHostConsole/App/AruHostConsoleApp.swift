import SwiftUI

@main
struct AruHostConsoleApp: App {
    @StateObject private var runtime = HostConsoleRuntime()

    var body: some Scene {
        WindowGroup {
            AruHostConsoleView(runtime: runtime)
                .frame(minWidth: 1040, minHeight: 680)
                .task { await runtime.start() }
        }
        .windowStyle(.hiddenTitleBar)
        .defaultSize(width: 1180, height: 760)
        .windowResizability(.contentMinSize)
        .commands {
            CommandGroup(replacing: .newItem) { }
            CommandGroup(after: .toolbar) {
                Button(L10n.refresh) {
                    Task { await runtime.refresh(forceDriverProbe: false) }
                }
                .keyboardShortcut("r", modifiers: .command)
            }
        }
    }
}
