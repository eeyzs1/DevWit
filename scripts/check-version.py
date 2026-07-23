#!/usr/bin/env python3
"""check-version.py — 跨平台版本检查（基于 git tag）。

版本真相源是 git tag（不用 VERSION 文件）：
  CURRENT = git describe --tags --abbrev-0（本地最近可到达的 tag）
  LATEST  = git ls-remote --tags origin 解析出的最大语义化版本号
  UPDATE_AVAILABLE = CURRENT < LATEST（语义化比较）

用法：python scripts/check-version.py
"""

import re
import subprocess
import sys
from pathlib import Path

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

MH_ROOT = Path(__file__).resolve().parent.parent

MH_REPO_SSH = "git@github.com:eeyzs1/meta_harness.git"
MH_REPO_HTTPS = "https://github.com/eeyzs1/meta_harness.git"


def run_git(*args):
    """Run a git command, return (stdout, returncode)."""
    try:
        proc = subprocess.run(
            ["git", *args],
            cwd=str(MH_ROOT),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        return proc.stdout.strip(), proc.returncode
    except Exception:
        return "", 1


def parse_semver(tag):
    """Parse 'v2.6.0' -> (2, 6, 0). Returns None if not a valid semver."""
    m = re.match(r'^v?(\d+)\.(\d+)\.(\d+)$', tag.strip())
    return tuple(int(x) for x in m.groups()) if m else None


def get_local_version():
    """本地最近可到达的 tag。"""
    out, rc = run_git("describe", "--tags", "--abbrev=0")
    if rc == 0 and out:
        return out
    # 本地无 tag，fetch 后重试
    run_git("fetch", "--tags", "--quiet")
    out, rc = run_git("describe", "--tags", "--abbrev=0")
    return out if rc == 0 and out else None


def get_remote_latest_tag(remote_url):
    """远端所有 tag 中语义化版本最大的。"""
    out, rc = run_git("ls-remote", "--tags", "origin")
    if rc != 0 or not out:
        # 协议 fallback
        alt_url = MH_REPO_HTTPS if remote_url.startswith("git@github.com:") else MH_REPO_SSH
        print("WARNING: origin unreachable, retrying with alternate protocol...", file=sys.stderr)
        out, rc = run_git("ls-remote", "--tags", alt_url)
        if rc != 0 or not out:
            return None

    # 解析所有 tag ref，过滤版本号格式，取最大
    tags = []
    for line in out.splitlines():
        m = re.search(r'refs/tags/(.+)$', line)
        if m and parse_semver(m.group(1).strip()):
            tags.append(m.group(1).strip())

    if not tags:
        return None
    return max(tags, key=parse_semver)


def main():
    remote_url, _ = run_git("remote", "get-url", "origin")

    current = get_local_version()
    if not current:
        print("CURRENT=unknown")
        print("LATEST=unknown")
        print("UPDATE_AVAILABLE=false")
        print("WARNING: No git tags found locally. Run: git tag v1.0.0", file=sys.stderr)
        return

    if not remote_url:
        print(f"CURRENT={current}")
        print("LATEST=unknown")
        print("UPDATE_AVAILABLE=false")
        print("WARNING: No git remote configured, cannot check for updates.", file=sys.stderr)
        return

    latest = get_remote_latest_tag(remote_url)
    if not latest:
        print(f"CURRENT={current}")
        print("LATEST=unknown")
        print("UPDATE_AVAILABLE=false")
        print("WARNING: Cannot reach remote to fetch tags.", file=sys.stderr)
        return

    cur_ver = parse_semver(current)
    lat_ver = parse_semver(latest)
    update = bool(cur_ver and lat_ver and cur_ver < lat_ver)

    print(f"CURRENT={current}")
    print(f"LATEST={latest}")
    print(f"UPDATE_AVAILABLE={'true' if update else 'false'}")

    if update:
        print()
        print("=" * 46)
        print("  Meta-Harness update available!")
        print(f"  Current: {current}")
        print(f"  Latest:  {latest}")
        print("  To update: python scripts/update-harness.py")
        print("=" * 46)


if __name__ == "__main__":
    main()
