cask "back2vibing" do
  version "0.7.17"
  sha256 "8a61b8483f77bc55140b593d3635628bfc008e02b4f0b0b55a20ff6f95099d83"

  url "https://github.com/builtby-win/back2vibing/releases/download/v0.7.17/back2vibing_#{version}_aarch64.dmg",
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
