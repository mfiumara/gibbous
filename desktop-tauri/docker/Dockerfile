# Linux build + headless smoke image for the Tauri shell (see desktop-tauri/README.md).
#   docker build -t gibbous-tauri-linux desktop-tauri/docker
FROM rust:1-bookworm
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libsoup-3.0-dev \
      libxdo-dev libssl-dev patchelf file xdg-utils \
      xvfb x11-apps imagemagick dbus-x11 dunst libnotify-bin socat curl ca-certificates \
      fonts-dejavu-core \
  && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
  && apt-get install -y nodejs \
  && rm -rf /var/lib/apt/lists/*
# Headless smoke test (docker/smoke.sh): WebDriver for WebKitGTK + tauri-driver, X11 inspection tools.
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends webkit2gtk-driver x11-utils xdotool \
  && rm -rf /var/lib/apt/lists/* && cargo install tauri-driver --locked
