cask "back2vibing" do
  version "0.6.12"
  sha256 "5c586545e00b7d4fb7e6a98f39c9156e4b67eef03516c89ca23c8183009c64f3"

  url "https://github.com/builtby-win/back2vibing/releases/download/v#{version}/back2vibing_#{version}_aarch64.dmg",
      verified: "github.com/builtby-win/back2vibing/"
  name "Back2Vibing"
  desc "Keeps you focused while long-running AI coding tasks finish"
  homepage "https://builtby.win/"

  livecheck do
    url :url
    strategy :github_latest
  end

  auto_updates true

  app "Back2Vibing.app"

  zap trash: [
    "~/Library/Application Support/back2vibing",
    "~/Library/Caches/back2vibing",
    "~/Library/Preferences/com.builtby-win.back2vibing.plist",
    "~/Library/WebKit/com.builtby-win.back2vibing",
  ]
end
