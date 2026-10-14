import Foundation
import Combine

@MainActor
final class SessionStore: ObservableObject {
    @Published private(set) var user: UserDTO?
    @Published private(set) var isBusy = false
    @Published private(set) var errorMessage: String?
    @Published private(set) var configurationError: String?
    private let client: APIClient?
    private var didRestore = false

    init() {
        do {
            let url = try AppConfiguration.functionsBaseURL()
            let service = (Bundle.main.bundleIdentifier ?? "com.example.Fcom") + "." + (url.host ?? "api")
            client = APIClient(baseURL: url, tokenStore: KeychainTokenStore(service: service))
        } catch {
            client = nil
            configurationError = error.localizedDescription
        }
    }

    func restore() async {
        guard !didRestore, !isBusy, let client else { return }
        didRestore = true
        isBusy = true
        defer { isBusy = false }
        do {
            guard try await client.hasStoredToken() else { return }
            user = try await client.me().user
        } catch is CancellationError { }
        catch { errorMessage = error.localizedDescription }
    }

    func login(nickname: String, password: String) async {
        guard !isBusy, let client else { return }
        isBusy = true
        errorMessage = nil
        defer { isBusy = false }
        do {
            // A successful login establishes identity even if the subsequent
            // profile refresh is unavailable; metadata arrives through /me.
            user = try await client.login(nickname: nickname.trimmingCharacters(in: .whitespacesAndNewlines), password: password).user
            user = try await client.me().user
        } catch is CancellationError { }
        catch {
            if (try? await client.hasStoredToken()) != true { user = nil }
            errorMessage = error.localizedDescription
        }
    }

    func refresh() async {
        guard !isBusy, let client else { return }
        isBusy = true
        errorMessage = nil
        defer { isBusy = false }
        do { user = try await client.me().user }
        catch is CancellationError { }
        catch {
            if (try? await client.hasStoredToken()) != true { user = nil }
            errorMessage = error.localizedDescription
        }
    }

    func logout() async {
        guard !isBusy, let client else { return }
        isBusy = true
        errorMessage = nil
        defer { isBusy = false }
        do { try await client.logout(); user = nil }
        catch {
            // Network/API failures occur after clearing the local token. A
            // Keychain failure leaves the profile visible so logout can retry.
            if !(error is KeychainError) { user = nil }
            errorMessage = error.localizedDescription
        }
    }
}
