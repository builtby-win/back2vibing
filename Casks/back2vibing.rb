cask "back2vibing" do
  version "0.6.9"
  sha256 "c76232f60be8e63991bcbc856c495756b2fd6339a3411032046440e37e62896b"

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
