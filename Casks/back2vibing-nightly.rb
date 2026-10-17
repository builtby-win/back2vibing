cask "back2vibing-nightly" do
  version "0.9.68"
  sha256 "408eb1e29b0e10f1060d3a0662651d9ef90f61791dfe7843557e7b3a60766da6"

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
