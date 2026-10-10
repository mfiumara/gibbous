// The native sign-in screen: scan the QR code from Settings → Devices, or paste the sign-in link.
import UIKit
import UniformTypeIdentifiers

final class ConnectViewController: UIViewController, UITextFieldDelegate {
  var onLink: (((login: URL, origin: URL)) -> Void)?
  var onCancel: (() -> Void)?
  private let message: String?
  private let canCancel: Bool
  private let error = UILabel.gibbous("", size: 14, color: Theme.oxide)
  private let field = UITextField()
  private let pastePanel = UIStackView()
  private let scroll = UIScrollView()
  private let sub = UILabel.gibbous("Connect to Gibbous on your Mac. On a signed-in device, open Settings → Devices to show your sign-in code.", size: 15, color: Theme.dust)

  init(message: String?, canCancel: Bool) {
    self.message = message; self.canCancel = canCancel
    super.init(nibName: nil, bundle: nil)
  }
  required init?(coder: NSCoder) { fatalError() }
  override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = Theme.bg
    view.accessibilityIdentifier = "connect"

    let logo = UIImageView(image: UIImage(named: "Logo"))
    logo.contentMode = .scaleAspectFit
    logo.widthAnchor.constraint(equalToConstant: 112).isActive = true
    logo.heightAnchor.constraint(equalToConstant: 112).isActive = true
    let title = UILabel.gibbous("Gibbous", size: 30, weight: .bold)
    error.text = message
    error.isHidden = message == nil

    let scan = UIButton.gibbous("Scan sign-in code", primary: true, image: "qrcode.viewfinder")
    scan.accessibilityIdentifier = "scan"
    scan.addAction(UIAction { [weak self] _ in self?.scan() }, for: .touchUpInside)
    let paste = UIButton.gibbous("Paste sign-in link", primary: false, image: "link")
    paste.accessibilityIdentifier = "paste-link"
    paste.addAction(UIAction { [weak self] _ in self?.togglePaste() }, for: .touchUpInside)

    // Paste panel: a field (the link holds the access token, so it's masked like the web sign-in form) plus the
    // system paste button, which reads the clipboard without the "Allow Paste" prompt.
    field.placeholder = "https://…/login?token=…"
    field.isSecureTextEntry = true
    field.autocorrectionType = .no
    field.autocapitalizationType = .none
    // A token typed by hand must arrive byte for byte: "--" must not become an em dash.
    field.smartDashesType = .no
    field.smartQuotesType = .no
    field.smartInsertDeleteType = .no
    field.spellCheckingType = .no
    field.keyboardType = .URL
    field.returnKeyType = .go
    field.textColor = Theme.text
    field.tintColor = Theme.tide
    field.backgroundColor = Theme.well
    field.layer.cornerRadius = 12
    field.font = .monospacedSystemFont(ofSize: 15, weight: .regular)
    field.attributedPlaceholder = NSAttributedString(string: field.placeholder ?? "", attributes: [.foregroundColor: Theme.dust])
    field.leftView = UIView(frame: CGRect(x: 0, y: 0, width: 14, height: 1)); field.leftViewMode = .always
    field.heightAnchor.constraint(equalToConstant: 48).isActive = true
    field.delegate = self
    field.accessibilityIdentifier = "link-field"
    pasteConfiguration = UIPasteConfiguration(acceptableTypeIdentifiers: [UTType.url.identifier, UTType.plainText.identifier])
    let pc = UIPasteControl.Configuration()
    pc.displayMode = .iconAndLabel
    pc.cornerStyle = .large
    pc.baseBackgroundColor = Theme.well
    pc.baseForegroundColor = Theme.text
    let pasteButton = UIPasteControl(configuration: pc)
    pasteButton.target = self
    pasteButton.heightAnchor.constraint(equalToConstant: 48).isActive = true
    let go = UIButton.gibbous("Connect", primary: true)
    go.accessibilityIdentifier = "connect-button"
    go.addAction(UIAction { [weak self] _ in self?.submit(self?.field.text ?? "") }, for: .touchUpInside)
    let row = UIStackView(arrangedSubviews: [pasteButton, go]); row.spacing = 10; row.distribution = .fillEqually
    pastePanel.addArrangedSubview(field); pastePanel.addArrangedSubview(row)
    pastePanel.axis = .vertical; pastePanel.spacing = 10
    pastePanel.isHidden = true

    let head = UIStackView(arrangedSubviews: [logo, title, sub, error]); head.axis = .vertical; head.alignment = .center; head.spacing = 12
    head.setCustomSpacing(20, after: logo)
    let actions = UIStackView(arrangedSubviews: [scan, paste, pastePanel]); actions.axis = .vertical; actions.spacing = 10
    let stack = UIStackView(arrangedSubviews: [head, actions]); stack.axis = .vertical; stack.spacing = 36
    if canCancel {
      var c = UIButton.Configuration.plain(); c.title = "Cancel"; c.baseForegroundColor = Theme.dust
      let cancel = UIButton(configuration: c)
      cancel.addAction(UIAction { [weak self] _ in self?.view.endEditing(true); self?.onCancel?() }, for: .touchUpInside)
      stack.addArrangedSubview(cancel)
      stack.setCustomSpacing(12, after: actions)
    }
    for v in [sub, error] { v.widthAnchor.constraint(equalTo: head.widthAnchor).isActive = true; v.setContentCompressionResistancePriority(.required, for: .vertical) }

    scroll.alwaysBounceVertical = false
    scroll.keyboardDismissMode = .interactive
    view.addSubview(scroll)
    scroll.addSubview(stack)
    scroll.translatesAutoresizingMaskIntoConstraints = false
    stack.translatesAutoresizingMaskIntoConstraints = false
    // Centred in the content, not the frame: the frame guide moves with the scroll offset, which would drag the
    // stack along and make the paste field impossible to scroll above the keyboard.
    let centre = stack.centerYAnchor.constraint(equalTo: scroll.contentLayoutGuide.centerYAnchor)
    centre.priority = .defaultLow
    let width = stack.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor, constant: -48)
    width.priority = .defaultHigh
    NSLayoutConstraint.activate([
      scroll.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
      scroll.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      scroll.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      scroll.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor),
      stack.topAnchor.constraint(greaterThanOrEqualTo: scroll.contentLayoutGuide.topAnchor, constant: 24),
      stack.bottomAnchor.constraint(lessThanOrEqualTo: scroll.contentLayoutGuide.bottomAnchor, constant: -24),
      scroll.contentLayoutGuide.heightAnchor.constraint(greaterThanOrEqualTo: scroll.frameLayoutGuide.heightAnchor),
      stack.centerXAnchor.constraint(equalTo: scroll.centerXAnchor),
      width, stack.widthAnchor.constraint(lessThanOrEqualToConstant: 400), centre,
    ])
    let fill = scroll.contentLayoutGuide.heightAnchor.constraint(equalTo: scroll.frameLayoutGuide.heightAnchor)
    fill.priority = .defaultLow
    fill.isActive = true
    NotificationCenter.default.addObserver(self, selector: #selector(revealField), name: UIResponder.keyboardDidShowNotification, object: nil)
  }

  // Multi-line labels in a centred stack inside a scroll view measure their height before their width is known.
  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    var changed = false
    for l in [sub, error] where l.preferredMaxLayoutWidth != l.bounds.width { l.preferredMaxLayoutWidth = l.bounds.width; changed = true }
    if changed { view.setNeedsLayout() }
  }

  // The keyboard shortens the scroll view (keyboardLayoutGuide): keep the paste field and its buttons above it.
  @objc private func revealField() {
    guard field.isFirstResponder else { return }
    view.layoutIfNeeded()
    // Measured on screen: how far the panel's bottom (plus a margin) sits below the scroll view's visible bottom.
    let panel = pastePanel.convert(pastePanel.bounds, to: nil), visible = scroll.convert(scroll.bounds, to: nil)
    let delta = panel.maxY + 16 - visible.maxY
    guard delta > 0 else { return }
    let y = scroll.contentOffset.y + delta
    UIView.animate(withDuration: 0.25) { self.scroll.contentOffset = CGPoint(x: 0, y: y) }
  }

  private func show(error text: String) {
    error.text = text
    UIView.animate(withDuration: 0.2, animations: { self.error.isHidden = false; self.view.layoutIfNeeded() }) { _ in self.revealField() }
    UINotificationFeedbackGenerator().notificationOccurred(.error)
  }

  private func togglePaste() {
    UIView.animate(withDuration: 0.25) { self.pastePanel.isHidden.toggle(); self.view.layoutIfNeeded() }
    if !pastePanel.isHidden { field.becomeFirstResponder() } else { field.resignFirstResponder() }
  }

  func submit(_ raw: String) {
    guard let link = Server.parseLink(raw) else {
      field.text = ""  // masked, so it can't be fixed in place: start over with the next paste
      show(error: raw.lowercased().hasPrefix("http://")
           ? "Use the https sign-in link (Tailscale). Plain http only works for a server on this device."
           : "That isn't a Gibbous sign-in link. It looks like https://your-mac…ts.net:8444/login?token=…")
      return
    }
    view.endEditing(true)
    onLink?(link)
  }

  func textFieldShouldReturn(_ t: UITextField) -> Bool { submit(t.text ?? ""); return false }

  // UIPasteControl delivers the clipboard here.
  override func canPaste(_ itemProviders: [NSItemProvider]) -> Bool { true }
  override func paste(itemProviders: [NSItemProvider]) {
    guard let p = itemProviders.first else { return }
    let done: (String?) -> Void = { s in DispatchQueue.main.async { guard let s else { return }; self.field.text = s; self.submit(s) } }
    if p.canLoadObject(ofClass: URL.self) { _ = p.loadObject(ofClass: URL.self) { u, _ in done(u?.absoluteString) } }
    else { _ = p.loadObject(ofClass: String.self) { s, _ in done(s) } }
  }

  private func scan() {
    let s = ScannerViewController()
    s.modalPresentationStyle = .fullScreen
    s.onCode = { [weak self, weak s] code in
      guard let self else { return }
      if Server.parseLink(code) != nil { s?.dismiss(animated: true) { self.submit(code) } }
      else { s?.flash("That code isn't a Gibbous sign-in code.") }
    }
    present(s, animated: true)
  }
}
