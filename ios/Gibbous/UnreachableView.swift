// "Can't reach your Mac": shown over the web view when the server doesn't answer. Retries by itself when the
// network comes back, on resume and every few seconds; Retry and Change server are there for impatience.
import UIKit

final class UnreachableView: UIView {
  var onRetry: (() -> Void)?
  var onChangeServer: (() -> Void)?
  private let detail = UILabel.gibbous("", size: 15, color: Theme.dust)
  private let retry = UIButton.gibbous("Retry", primary: true)

  override init(frame: CGRect) {
    super.init(frame: frame)
    backgroundColor = Theme.bg
    let logo = UIImageView(image: UIImage(named: "Logo"))
    logo.contentMode = .scaleAspectFit
    logo.alpha = 0.55
    logo.widthAnchor.constraint(equalToConstant: 88).isActive = true
    logo.heightAnchor.constraint(equalToConstant: 88).isActive = true
    let title = UILabel.gibbous("Can't reach your Mac", size: 22, weight: .bold)
    let change = UIButton.gibbous("Change server", primary: false)
    retry.addAction(UIAction { [weak self] _ in self?.onRetry?() }, for: .touchUpInside)
    change.addAction(UIAction { [weak self] _ in self?.onChangeServer?() }, for: .touchUpInside)
    retry.accessibilityIdentifier = "retry"

    let text = UIStackView(arrangedSubviews: [title, detail]); text.axis = .vertical; text.spacing = 8
    let buttons = UIStackView(arrangedSubviews: [retry, change]); buttons.axis = .vertical; buttons.spacing = 10
    let stack = UIStackView(arrangedSubviews: [logo, text, buttons]); stack.axis = .vertical; stack.alignment = .center; stack.spacing = 28
    text.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
    buttons.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
    addSubview(stack)
    stack.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
      stack.centerYAnchor.constraint(equalTo: safeAreaLayoutGuide.centerYAnchor),
      stack.centerXAnchor.constraint(equalTo: centerXAnchor),
      { let c = stack.widthAnchor.constraint(equalTo: readableContentGuide.widthAnchor, constant: -16); c.priority = .defaultHigh; return c }(),
      stack.widthAnchor.constraint(lessThanOrEqualToConstant: 380),
    ])
  }
  required init?(coder: NSCoder) { fatalError() }

  func show(detail text: String) {
    detail.text = text
    setBusy(false)
    guard isHidden else { return }
    alpha = 0; isHidden = false
    UIView.animate(withDuration: 0.2) { self.alpha = 1 }
  }

  func setBusy(_ busy: Bool) {
    retry.configuration?.showsActivityIndicator = busy
    retry.configuration?.title = busy ? "Connecting…" : "Retry"
    retry.isUserInteractionEnabled = !busy
  }
}
