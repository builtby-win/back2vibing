cask "back2vibing" do
  version "0.7.16"
  sha256 "2d97553c34f926cd49c921ed1e5c71965b0d1b29bac41f68d255c7e0f0684717"

  url "https://github.com/builtby-win/back2vibing/releases/download/v0.7.16/back2vibing_#{version}_aarch64.dmg",
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
