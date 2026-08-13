cask "back2vibing-nightly" do
  version "0.9.14"
  sha256 "a4318d52b9e0fc0579fd0ce4ba68d805fdc32ebb0c8a6d9b8040fa07eace6633"

  url "https://github.com/builtby-win/back2vibing/releases/download/nightly/back2vibing_#{version}_aarch64.dmg",
      verified: "github.com/builtby-win/back2vibing/"
  name "Back2Vibing Nightly"
  desc "Nightly builds for Back2Vibing"
  homepage "https://back2vibing.builtby.win/"

  livecheck do
    url :url
    strategy :github_prerelease
  end

  auto_updates true

  conflicts_with cask: "back2vibing"

  app "Back2Vibing.app"

  zap trash: [
    "~/Library/Application Support/back2vibing",
    "~/Library/Caches/back2vibing",
    "~/Library/Preferences/com.builtby-win.back2vibing.plist",
    "~/Library/WebKit/com.builtby-win.back2vibing",
  ]
end
