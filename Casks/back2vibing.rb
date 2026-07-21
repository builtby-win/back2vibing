cask "back2vibing" do
  version "0.8.14"
  sha256 "efee298fae73daa7b87f44bfccd0400f5ebc28ac9d89b4be5dda8e9c41e7d73e"

  url "https://github.com/builtby-win/back2vibing/releases/download/v0.8.14/back2vibing_#{version}_aarch64.dmg",
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
