# Homebrew Cask for DevWit — 个人 tap（eeyzs1/homebrew-tap）分发。
# 用户安装：brew install --cask eeyzs1/tap/devwit
# sha256 实证来源：v0.2.0 Release 实际 dmg 资产经 GitHub API octet-stream 下载后计算
#（下载大小 111010464 字节与 Release 元数据一致）。
cask "devwit" do
  version "0.2.0"
  sha256 "27bc9cbaff5c1d3b7c2d9223d3b9ba825726a1b1a1c286bd4239f907d3dc6327"

  url "https://github.com/eeyzs1/DevWit/releases/download/v#{version}/DevWit-#{version}-arm64.dmg"
  name "DevWit"
  desc "Lean-context AI-native desktop IDE (简洁上下文 AI 原生桌面 IDE)"
  homepage "https://github.com/eeyzs1/DevWit"

  # v0.1.1 仅发布 Apple Silicon 资产（CI macos arm64 runner 构建）；Intel Mac 暂无对应包。
  depends_on arch: :arm64

  app "DevWit.app"

  # 未签名开发分发：Gatekeeper 首次打开会拦截，brew 安装后执行一次去隔离即可。
  # （homebrew 对 cask 默认保留 quarantine 属性）
  caveats <<~EOS
    DevWit is distributed unsigned. After install, run once:
      xattr -dr com.apple.quarantine /Applications/DevWit.app
    Auto-update on macOS requires a signed build; until then, upgrade via:
      brew upgrade --cask eeyzs1/tap/devwit
  EOS

  zap trash: [
    "~/Library/Application Support/DevWit",
    "~/Library/Preferences/com.devwit.app.plist",
  ]
end
