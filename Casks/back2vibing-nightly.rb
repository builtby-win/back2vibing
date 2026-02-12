cask "back2vibing-nightly" do
  version "0.6.15"
  sha256 "4d1324165c2c041625eb60f2dfe2e26302c2c0da18e1b70ed8fedd4ed31d1e44"

  url "https://github.com/builtby-win/back2vibing/releases/download/v0.6.15/back2vibing_#{version}_aarch64.dmg",
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
