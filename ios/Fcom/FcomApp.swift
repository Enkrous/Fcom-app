import SwiftUI

@main
@MainActor
struct FcomApp: App {
    @StateObject private var session = SessionStore()
    var body: some Scene {
        WindowGroup { ContentView().environmentObject(session) }
    }
}
