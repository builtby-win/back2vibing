cask "back2vibing" do
  version "0.6.12"
  sha256 "17b735d6e5a0fe49e0435895599b8731acf966c6efa20bed4d0cafff4053ad8d"

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
