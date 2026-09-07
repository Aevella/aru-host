import Foundation

/// The app packager installs SwiftPM resources inside Contents/Resources.
/// Bundle.module only knows the executable bundle root and the build directory.
enum HostConsoleResources {
    static let bundle = resolve(in: .main, packageBundle: .module)

    static func resolve(in application: Bundle, packageBundle: @autoclosure () -> Bundle) -> Bundle {
        if let url = application.resourceURL?.appending(path: "AruHostConsole_AruHostConsole.bundle"),
           let bundle = Bundle(url: url) {
            return bundle
        }
        // Keep this lazy: evaluating Bundle.module in a distributed app traps.
        return packageBundle()
    }
}
