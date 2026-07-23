cask "back2vibing" do
  version "0.8.20"
  sha256 "bc9dd0d4b18ec4d75db91b66adc177acff96cf62f129a0a76d21302f5eb4815c"

  url "https://github.com/builtby-win/back2vibing/releases/download/v0.8.20/back2vibing_#{version}_aarch64.dmg",
      verified: "github.com/builtby-win/back2vibing/"
  name "Back2Vibing"
  desc "Keeps you focused while long-running AI coding tasks finish"
  homepage "https://back2vibing.builtby.win/"

  livecheck do
    url :url
    strategy :github_latest
  end

  auto_updates true

  conflicts_with cask: "back2vibing-nightly"

  app "Back2Vibing.app"

  zap trash: [
    "~/Library/Application Support/back2vibing",
    "~/Library/Caches/back2vibing",
    "~/Library/Preferences/com.builtby-win.back2vibing.plist",
    "~/Library/WebKit/com.builtby-win.back2vibing",
  ]
end
