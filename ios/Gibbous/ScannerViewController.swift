// Full-screen QR scanner for the sign-in code (Settings → Devices on the Mac).
import UIKit
import AVFoundation

final class ScannerViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
  var onCode: ((String) -> Void)?
  private let session = AVCaptureSession()
  private let queue = DispatchQueue(label: "dev.gibbous.ios.scanner")
  private let hint = UILabel.gibbous("Point at the sign-in code in Settings → Devices", size: 15, weight: .medium)
  private var lastCode: String?

  override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .black

    let frame = UIView()
    frame.layer.borderColor = Theme.tide.cgColor
    frame.layer.borderWidth = 3
    frame.layer.cornerRadius = 24
    frame.isUserInteractionEnabled = false
    var c = UIButton.Configuration.filled()
    c.image = UIImage(systemName: "xmark", withConfiguration: UIImage.SymbolConfiguration(pointSize: 15, weight: .bold))
    c.cornerStyle = .capsule
    c.baseBackgroundColor = UIColor(white: 0, alpha: 0.5)
    c.baseForegroundColor = .white
    let close = UIButton(configuration: c)
    close.accessibilityLabel = "Close"
    close.addAction(UIAction { [weak self] _ in self?.dismiss(animated: true) }, for: .touchUpInside)
    hint.layer.shadowColor = UIColor.black.cgColor; hint.layer.shadowOpacity = 0.8; hint.layer.shadowRadius = 6; hint.layer.shadowOffset = .zero

    for v in [frame, close, hint] as [UIView] { v.translatesAutoresizingMaskIntoConstraints = false; view.addSubview(v) }
    NSLayoutConstraint.activate([
      frame.centerXAnchor.constraint(equalTo: view.centerXAnchor), frame.centerYAnchor.constraint(equalTo: view.centerYAnchor),
      frame.widthAnchor.constraint(equalToConstant: 250), frame.heightAnchor.constraint(equalToConstant: 250),
      close.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 12),
      close.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -16),
      close.widthAnchor.constraint(equalToConstant: 40), close.heightAnchor.constraint(equalToConstant: 40),
      hint.topAnchor.constraint(equalTo: frame.bottomAnchor, constant: 28),
      hint.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 32), hint.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -32),
    ])

    switch AVCaptureDevice.authorizationStatus(for: .video) {
    case .authorized: start()
    case .notDetermined: AVCaptureDevice.requestAccess(for: .video) { ok in DispatchQueue.main.async { ok ? self.start() : self.denied() } }
    default: denied()
    }
  }

  private func denied() {
    hint.text = "Gibbous can't use the camera. Allow it in Settings → Gibbous, or paste the sign-in link instead."
  }

  private func start() {
    guard let cam = AVCaptureDevice.default(for: .video), let input = try? AVCaptureDeviceInput(device: cam), session.canAddInput(input) else {
      hint.text = "No camera available. Paste the sign-in link instead."
      return
    }
    session.addInput(input)
    let out = AVCaptureMetadataOutput()
    guard session.canAddOutput(out) else { return }
    session.addOutput(out)
    out.setMetadataObjectsDelegate(self, queue: .main)
    out.metadataObjectTypes = [.qr]
    let preview = AVCaptureVideoPreviewLayer(session: session)
    preview.videoGravity = .resizeAspectFill
    preview.frame = view.bounds
    view.layer.insertSublayer(preview, at: 0)
    queue.async { self.session.startRunning() }
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    view.layer.sublayers?.compactMap { $0 as? AVCaptureVideoPreviewLayer }.forEach { $0.frame = view.bounds }
  }

  override func viewWillDisappear(_ animated: Bool) {
    super.viewWillDisappear(animated)
    queue.async { if self.session.isRunning { self.session.stopRunning() } }
  }

  func metadataOutput(_ o: AVCaptureMetadataOutput, didOutput objects: [AVMetadataObject], from c: AVCaptureConnection) {
    guard let code = (objects.first as? AVMetadataMachineReadableCodeObject)?.stringValue, code != lastCode else { return }
    lastCode = code
    UIImpactFeedbackGenerator(style: .medium).impactOccurred()
    onCode?(code)
  }

  /// A QR code that isn't ours: say so, then accept the next one.
  func flash(_ text: String) {
    hint.text = text
    UINotificationFeedbackGenerator().notificationOccurred(.warning)
    DispatchQueue.main.asyncAfter(deadline: .now() + 2) { self.lastCode = nil; self.hint.text = "Point at the sign-in code in Settings → Devices" }
  }
}
