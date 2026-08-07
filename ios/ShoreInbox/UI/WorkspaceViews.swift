import SwiftUI
import AVKit

struct ContactsView: View {
    @StateObject private var model = ContactsModel()
    @EnvironmentObject private var session: SessionModel
    @State private var search = ""
    @State private var showingCreate = false

    private var filtered: [ConversationSummary] {
        let contacts = model.contacts.filter { $0.phone != session.callerNumber }
        guard !search.isEmpty else { return contacts }
        let query = search.lowercased()
        return contacts.filter {
            $0.displayName.lowercased().contains(query) || $0.phone.contains(query) ||
            ($0.email?.lowercased().contains(query) ?? false)
        }
    }

    private var businessLineMatchesSearch: Bool {
        guard !session.callerNumber.isEmpty else { return false }
        guard !search.isEmpty else { return true }
        let query = search.lowercased()
        return "the shore academy".contains(query) || session.callerNumber.contains(query) ||
            PhoneFormatter.pretty(session.callerNumber).lowercased().contains(query)
    }

    var body: some View {
        NavigationStack {
            Group {
                if model.isLoading && model.contacts.isEmpty { ProgressView("Loading contacts…") }
                else if filtered.isEmpty && !businessLineMatchesSearch {
                    EmptyState(icon: "person.2", title: "No contacts", detail: search.isEmpty ? "Create the first contact." : "Try another search.")
                } else {
                    List {
                        if businessLineMatchesSearch {
                            NavigationLink {
                                BusinessLineDetailView(phone: session.callerNumber)
                            } label: {
                                HStack(spacing: 12) {
                                    InitialsAvatar(name: "The Shore Academy", imageURL: nil)
                                    VStack(alignment: .leading, spacing: 3) {
                                        HStack(spacing: 5) {
                                            Text("The Shore Academy").fontWeight(.semibold)
                                            Image(systemName: "pin.fill").font(.caption2).foregroundColor(ShoreTheme.tint)
                                        }
                                        Text(PhoneFormatter.pretty(session.callerNumber))
                                            .font(.caption).foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    Text("Business line").font(.caption2).foregroundStyle(.secondary)
                                }
                            }
                        }

                        ForEach(filtered) { contact in
                            NavigationLink {
                                ContactDetailView(phone: contact.phone, model: model)
                            } label: {
                                HStack(spacing: 12) {
                                    InitialsAvatar(name: contact.displayName, imageURL: contact.avatarURL)
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(contact.displayName)
                                        Text(contact.phone).font(.caption).foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    if let status = contact.latestOrderStatus {
                                        Text(status.replacingOccurrences(of: "-", with: " ").capitalized)
                                            .font(.caption2).padding(.horizontal, 7).padding(.vertical, 3)
                                            .background(Color(.tertiarySystemFill)).clipShape(Capsule())
                                    }
                                }
                            }
                        }
                    }.listStyle(.plain).refreshable { await model.load() }
                }
            }
            .navigationTitle("Contacts")
            .searchable(text: $search, prompt: "Name, phone, or email")
            .toolbar { Button { showingCreate = true } label: { Image(systemName: "person.badge.plus") } }
            .sheet(isPresented: $showingCreate) {
                ContactEditor(title: "New Contact") { first, last, phone, email, notes in
                    let saved = await model.create(firstName: first, lastName: last, phone: phone, email: email, notes: notes)
                    if saved { showingCreate = false }
                    return saved
                }
            }
            .task { if model.contacts.isEmpty { await model.load() } }
            .alert("Contacts error", isPresented: errorBinding) { Button("OK", role: .cancel) {} }
                message: { Text(model.errorMessage ?? "Unknown error") }
        }
    }

    private var errorBinding: Binding<Bool> { Binding(get: { model.errorMessage != nil }, set: { if !$0 { model.errorMessage = nil } }) }
}

private struct BusinessLineDetailView: View {
    let phone: String
    @State private var copied = false

    var body: some View {
        List {
            Section {
                HStack(spacing: 14) {
                    InitialsAvatar(name: "The Shore Academy", imageURL: nil)
                    VStack(alignment: .leading, spacing: 3) {
                        Text("The Shore Academy").font(.title3.bold())
                        Text(PhoneFormatter.pretty(phone)).foregroundStyle(.secondary).textSelection(.enabled)
                    }
                }.padding(.vertical, 4)
            }
            Section {
                Button {
                    UIPasteboard.general.string = phone
                    copied = true
                } label: {
                    Label(copied ? "Number copied" : "Copy business number", systemImage: copied ? "checkmark" : "doc.on.doc")
                }
            } footer: {
                Text("This is The Shore Academy business number used for client messages and calls.")
            }
        }
        .navigationTitle("Business Line")
        .navigationBarTitleDisplayMode(.inline)
    }
}

private struct ContactDetailView: View {
    let phone: String
    @ObservedObject var model: ContactsModel
    @EnvironmentObject private var session: SessionModel
    @State private var editing = false

    var body: some View {
        Group {
            if model.isLoading && model.detail?.contact.phone != phone { ProgressView("Loading contact…") }
            else if let detail = model.detail, detail.contact.phone == phone {
                List {
                    Section {
                        HStack(spacing: 14) {
                            InitialsAvatar(name: detail.contact.displayName, imageURL: detail.contact.avatarURL)
                            VStack(alignment: .leading) {
                                Text(detail.contact.displayName).font(.title3.bold())
                                Text(detail.contact.phone).foregroundStyle(.secondary)
                                if let email = detail.contact.email, !email.isEmpty { Text(email).font(.subheadline).foregroundStyle(.secondary) }
                            }
                        }.padding(.vertical, 4)
                        HStack {
                            Button { session.startOutgoingCall(to: detail.contact.phone) } label: { Label("Call", systemImage: "phone.fill") }
                            Spacer()
                            Button { editing = true } label: { Label("Edit", systemImage: "pencil") }
                        }
                    }
                    if let notes = detail.contact.notes, !notes.isEmpty { Section("Notes") { Text(notes) } }
                    Section("Orders") {
                        if detail.orders.isEmpty { Text("No orders").foregroundStyle(.secondary) }
                        ForEach(detail.orders) { order in OrderRow(order: order) }
                    }
                    if let intelligence = detail.intelligence {
                        Section("Customer intelligence") {
                            if let summary = intelligence.summary { Text(summary) }
                            if let sentiment = intelligence.sentiment { LabeledContent("Sentiment", value: sentiment.capitalized) }
                            if let interests = intelligence.interests, !interests.isEmpty { LabeledContent("Interests", value: interests.joined(separator: ", ")) }
                        }
                    }
                    if let suggestions = detail.suggestions, !suggestions.isEmpty {
                        Section("Campaign suggestions") {
                            ForEach(suggestions) { suggestion in
                                VStack(alignment: .leading, spacing: 5) {
                                    Text(suggestion.suggestedMessage ?? "Suggested message")
                                    if let reason = suggestion.reason { Text(reason).font(.caption).foregroundStyle(.secondary) }
                                }
                            }
                        }
                    }
                }
                .refreshable { await model.loadDetail(phone: phone) }
                .sheet(isPresented: $editing) {
                    ContactEditor(title: "Edit Contact", contact: detail.contact) { first, last, _, email, notes in
                        let saved = await model.update(detail.contact, firstName: first, lastName: last, email: email, notes: notes)
                        if saved { editing = false }
                        return saved
                    }
                }
            } else { EmptyState(icon: "person.crop.circle.badge.questionmark", title: "Contact unavailable", detail: "Pull to try again.") }
        }
        .navigationTitle("Contact")
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.loadDetail(phone: phone) }
    }
}

private struct OrderRow: View {
    let order: OrderRecord
    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack {
                Text(order.wooOrderID.map { "Order #\($0.rawValue)" } ?? "Order").fontWeight(.semibold)
                Spacer()
                Text((order.status ?? "unknown").replacingOccurrences(of: "-", with: " ").capitalized)
                    .font(.caption).foregroundStyle(.secondary)
            }
            if let items = order.items, !items.isEmpty {
                Text(items.map { "\($0.quantity ?? 1)× \($0.name ?? "Item")" }.joined(separator: ", "))
                    .font(.subheadline).foregroundStyle(.secondary)
            }
            HStack {
                if let total = order.total { Text("$\(total.currencyText)").font(.subheadline.bold()) }
                Spacer()
                if let date = ServerDate.parse(order.createdAt) { Text(date, style: .date).font(.caption).foregroundStyle(.secondary) }
            }
            if let tracking = order.trackingNumber, !tracking.isEmpty {
                Label("\(order.carrier ?? "Tracking"): \(tracking)", systemImage: "shippingbox")
                    .font(.caption).textSelection(.enabled)
            }
        }.padding(.vertical, 4)
    }
}

private struct ContactEditor: View {
    let title: String
    let contact: ConversationSummary?
    let save: (String, String, String, String, String) async -> Bool
    @Environment(\.dismiss) private var dismiss
    @State private var firstName: String
    @State private var lastName: String
    @State private var phone: String
    @State private var email: String
    @State private var notes: String
    @State private var saving = false

    init(title: String, contact: ConversationSummary? = nil,
         save: @escaping (String, String, String, String, String) async -> Bool) {
        self.title = title; self.contact = contact; self.save = save
        _firstName = State(initialValue: contact?.firstName ?? "")
        _lastName = State(initialValue: contact?.lastName ?? "")
        _phone = State(initialValue: contact?.phone ?? "")
        _email = State(initialValue: contact?.email ?? "")
        _notes = State(initialValue: contact?.notes ?? "")
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Name") { TextField("First name", text: $firstName); TextField("Last name", text: $lastName) }
                Section("Contact") {
                    TextField("Phone", text: $phone).keyboardType(.phonePad).disabled(contact != nil)
                    TextField("Email", text: $email).keyboardType(.emailAddress).textInputAutocapitalization(.never)
                }
                Section("Notes") { TextField("Notes", text: $notes, axis: .vertical).lineLimit(3...8) }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(saving ? "Saving…" : "Save") {
                        saving = true
                        Task { _ = await save(firstName, lastName, phone, email, notes); saving = false }
                    }.disabled(phone.isEmpty || saving)
                }
            }
        }
    }
}

struct CallsView: View {
    @ObservedObject var model: CallHistoryModel
    @State private var section = 0
    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                Picker("Calls section", selection: $section) {
                    Text("Keypad").tag(0); Text("History").tag(1)
                }.pickerStyle(.segmented).padding()
                if section == 0 { DialerView() } else { CallHistoryView(model: model) }
            }.navigationTitle("Calls")
        }
    }
}

private struct CallHistoryView: View {
    @ObservedObject var model: CallHistoryModel
    @EnvironmentObject private var session: SessionModel
    var body: some View {
        Group {
            if model.isLoading && model.logs.isEmpty { ProgressView("Loading calls…") }
            else if model.logs.isEmpty { EmptyState(icon: "phone.arrow.down.left", title: "No calls yet", detail: "Incoming and outgoing calls will appear here.") }
            else {
                List(model.logs) { log in
                    HStack(spacing: 12) {
                        Image(systemName: icon(log)).foregroundColor(color(log))
                        VStack(alignment: .leading, spacing: 3) {
                            Text(log.contactName ?? log.contactPhone.map(PhoneFormatter.pretty) ?? "Unknown number")
                            if let name = log.contactName, let phone = log.contactPhone {
                                Text(PhoneFormatter.pretty(phone)).font(.caption).foregroundStyle(.secondary)
                            }
                            HStack {
                                Text((log.status ?? "unknown").capitalized)
                                if let duration = log.durationSeconds, duration > 0 { Text("• \(duration / 60):\(String(format: "%02d", duration % 60))") }
                            }.font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        if let date = ServerDate.parse(log.startedAt) { Text(date, style: .relative).font(.caption).foregroundStyle(.secondary) }
                        if let phone = log.contactPhone {
                            Button { session.startOutgoingCall(to: phone) } label: { Image(systemName: "phone") }.buttonStyle(.borderless)
                        }
                    }
                }.listStyle(.plain)
                    .refreshable { await model.load(); await model.markHistorySeen() }
            }
        }
        // Reaching this list is what clears the missed-call count: the operator
        // can see who called without opening anything further.
        .task {
            if model.logs.isEmpty { await model.load() }
            await model.markHistorySeen()
        }
        // A refresh can raise the count while this list is already on screen —
        // returning to the foreground reloads it. Clear it again rather than
        // showing a badge for calls the operator is currently looking at.
        .onChange(of: model.unseenMissed) { count in
            if count > 0 { Task { await model.markHistorySeen() } }
        }
    }

    private func icon(_ log: CallLogRecord) -> String {
        if log.status == "missed" { return "phone.down.fill" }
        return log.direction == "inbound" ? "phone.arrow.down.left.fill" : "phone.arrow.up.right.fill"
    }
    private func color(_ log: CallLogRecord) -> Color {
        log.status == "missed" ? ShoreTheme.rescueOrange : ShoreTheme.seaGreen
    }
}
