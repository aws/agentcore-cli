"""Installs box into the image at build time, as the box release's install steps do.

Downloads the Linux arm64 archive of box BOX_VERSION from the github.com/BOX_REPO release,
checks it against BOX_SHA256, and unpacks it into the folder given as the only argument
(/opt/box): box, its two helpers, its packs and release.json.

A private release needs a GitHub token that can read BOX_REPO, in the BuildKit secret gh_token
(RUN --mount=type=secret,id=gh_token). On deploy CodeBuild reads it from Secrets Manager; under
`agentcore dev` it is your GitHub login. Without the secret the release must be public, and the
archive comes from its public download URL.
"""

import hashlib
import json
import os
import sys
import tarfile
import urllib.request

REPO = os.environ["BOX_REPO"]
VERSION = os.environ["BOX_VERSION"]
SHA256 = os.environ["BOX_SHA256"]
ASSET = f"box-v{VERSION}-aarch64-unknown-linux-gnu.tar.gz"
BINARIES = ("box", "strands-box-sock-alias", "strands-box-contain-trampoline")
TOKEN_FILE = "/run/secrets/gh_token"


def fail(message: str) -> None:
    sys.exit(f"install-box: {message}")


def token() -> str:
    if not os.path.isfile(TOKEN_FILE):
        return ""
    with open(TOKEN_FILE, encoding="utf-8") as file:
        return file.read().strip()


def get(url: str, accept: str, bearer: str) -> bytes:
    request = urllib.request.Request(url, headers={"Accept": accept, "User-Agent": "install-box"})
    if bearer:
        # Kept off the redirect to the asset's storage, which refuses a second credential.
        request.add_unredirected_header("Authorization", f"Bearer {bearer}")
    with urllib.request.urlopen(request, timeout=300) as response:
        return response.read()


def archive_url(bearer: str) -> str:
    if not bearer:
        return f"https://github.com/{REPO}/releases/download/v{VERSION}/{ASSET}"
    # A private release's assets download only through the API, by asset URL.
    release = json.loads(
        get(
            f"https://api.github.com/repos/{REPO}/releases/tags/v{VERSION}",
            "application/vnd.github+json",
            bearer,
        )
    )
    for asset in release.get("assets", []):
        if asset.get("name") == ASSET:
            return asset["url"]
    fail(f"release v{VERSION} of {REPO} has no {ASSET}")
    return ""


def main() -> None:
    if len(sys.argv) != 2:
        fail("usage: install-box.py <folder>")
    folder = sys.argv[1]
    bearer = token()
    try:
        data = get(archive_url(bearer), "application/octet-stream", bearer)
    except OSError as error:
        reason = "" if bearer else " The release is not public: mount a GitHub token as gh_token."
        fail(f"cannot download {ASSET} from {REPO}: {error}.{reason}")
    digest = hashlib.sha256(data).hexdigest()
    if digest != SHA256:
        fail(f"{ASSET} has SHA-256 {digest}, not the pinned {SHA256}")

    os.makedirs(folder, exist_ok=True)
    archive = os.path.join(folder, ".box.tar.gz")
    with open(archive, "wb") as file:
        file.write(data)
    try:
        with tarfile.open(archive) as tar:
            tar.extractall(folder, filter="data")
    finally:
        os.remove(archive)
    for binary in BINARIES:
        path = os.path.join(folder, binary)
        if not os.path.isfile(path):
            fail(f"{ASSET} has no {binary}")
        os.chmod(path, 0o755)
    print(f"install-box: box {VERSION} from {REPO} in {folder}")


if __name__ == "__main__":
    main()
