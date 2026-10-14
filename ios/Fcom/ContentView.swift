import SwiftUI

@MainActor
struct ContentView: View {
    @EnvironmentObject private var session: SessionStore
    @State private var nickname = ""
    @State private var password = ""

    var body: some View {
        NavigationStack {
            Form {
                if let configurationError = session.configurationError {
                    Text(configurationError).foregroundStyle(.red)
                } else if let user = session.user {
                    Section("Профиль") {
                        LabeledContent("Никнейм", value: "@" + user.nickname)
                        LabeledContent("Имя", value: user.fullName)
                        LabeledContent("Школа", value: user.school)
                        LabeledContent("Класс", value: user.grade)
                        LabeledContent("Кредо", value: user.cred.formatted())
                        if let level = user.credLevel { LabeledContent("Уровень", value: level.name) }
                        if let progress = user.credProgress { ProgressView(value: progress) }
                    }
                    Section {
                        Button("Обновить профиль") { Task { await session.refresh() } }
                        Button("Выйти", role: .destructive) { Task { await session.logout() } }
                    }.disabled(session.isBusy)
                } else {
                    Section("Вход") {
                        TextField("Никнейм", text: $nickname)
                            .textContentType(.username).textInputAutocapitalization(.never).autocorrectionDisabled()
                        SecureField("Пароль", text: $password).textContentType(.password)
                        Button("Войти") {
                            Task {
                                await session.login(nickname: nickname, password: password)
                                password = ""
                            }
                        }.disabled(session.isBusy || nickname.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || password.isEmpty)
                    }.disabled(session.isBusy)
                }
                if session.isBusy { ProgressView("Загружаем…") }
                if let message = session.errorMessage { Text(message).foregroundStyle(.red) }
            }
            .navigationTitle("Fcom")
        }
        .task { await session.restore() }
    }
}
