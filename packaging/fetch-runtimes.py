#!/usr/bin/env python3
"""Download the pinned agent runtimes for one platform and check them against packaging/runtimes.lock.json.

Usage: fetch-runtimes.py <platform> <directory>
  platform: linux-x64, linux-arm64, macos-x64, macos-arm64 or windows-x64
Writes <directory>/claude and <directory>/omp (with .exe on Windows). Nothing is written unless its checksum matches.
Only the standard library is used.
"""
import base64
import hashlib
import io
import json
import os
import sys
import tarfile
import urllib.request


def download(url):
    request = urllib.request.Request(url, headers={"User-Agent": "neo-agent-packaging"})
    with urllib.request.urlopen(request, timeout=600) as response:
        return response.read()


def verify(name, data, entry):
    """Stop unless the data is what the lock file pins: an npm `integrity` (sha512, base64) or a `sha256` in hex."""
    if "integrity" in entry:
        algorithm, _, expected = entry["integrity"].partition("-")
        actual = base64.b64encode(hashlib.new(algorithm, data).digest()).decode()
    else:
        expected, actual = entry["sha256"], hashlib.sha256(data).hexdigest()
    if actual != expected:
        sys.exit(f"{name}: checksum mismatch for {entry['url']}\n  expected {expected}\n  actual   {actual}")


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    platform, directory = sys.argv[1], sys.argv[2]
    lock_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "runtimes.lock.json")
    with open(lock_path, encoding="utf-8") as file:
        lock = json.load(file)
    suffix = ".exe" if platform.startswith("windows") else ""
    programs = {}
    for name in ("claude", "omp"):
        entry = lock[name]["platforms"].get(platform)
        if entry is None:
            sys.exit(f"{name} {lock[name]['version']} is not pinned for {platform}")
        print(f"{name} {lock[name]['version']}: {entry['url']}", flush=True)
        data = download(entry["url"])
        verify(name, data, entry)
        if "member" in entry:
            # An npm package: the program is one file of the tarball.
            with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
                member = archive.extractfile(entry["member"])
                if member is None:
                    sys.exit(f"{name}: {entry['member']} is not in the package")
                data = member.read()
        programs[name + suffix] = data
    # Both are checked before either is written.
    os.makedirs(directory, exist_ok=True)
    for file_name, data in programs.items():
        path = os.path.join(directory, file_name)
        with open(path, "wb") as file:
            file.write(data)
        os.chmod(path, 0o755)
        print(f"wrote {path} ({len(data) // (1024 * 1024)} MiB)")


if __name__ == "__main__":
    main()
