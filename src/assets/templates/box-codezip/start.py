# Runs the agent in a box on AgentCore Runtime (CodeZip). The Runtime's entry point must be a .py
# file, so this prepares a writable HOME and workspace, copies the box profile out of the read-only
# zip into a folder this user owns (box runs only a profile its user owns), exports the Python and
# code paths that only the microVM knows, and hands over to `box run`.
#
# The box profile reads the deployed resources, the gateway URL, the Python interpreter and the code
# directory from the environment through the box/agentcore and box/agentcore-codezip packs, and
# signs AWS routes with the execution role through a bare `aws://`. So there is nothing to fill in,
# no credentials to write, and no start.sh.
import json
import os
import re
import shutil
import sys

try:
    import tomllib
except ModuleNotFoundError:  # Python 3.10, which has no tomllib.
    tomllib = None

CODE = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.join(CODE, ".box-dist")
BOX = os.path.join(DIST, "box")
HOME = "/tmp/box/home"
WORKSPACE = "/tmp/box/workspace"
PROFILE_DIR = "/tmp/box/profile"
PROFILE = os.path.join(PROFILE_DIR, "profile.toml")

for directory in (HOME, WORKSPACE, PROFILE_DIR):
    os.makedirs(directory, exist_ok=True)

def staged_policies(path):
    """The policy files the staged profile's `policies` names.

    Deploy writes `policies` on one line, with names of only letters, digits, ".", "_", "-" and
    "/", so on Python 3.10 the line reads as a JSON list. The box templates reuse the folders of
    the agents without box, so no template has to depend on tomli for it.
    """
    with open(path, "rb") as handle:
        text = handle.read()
    if tomllib is not None:
        return tomllib.loads(text.decode("utf-8")).get("policies", [])
    match = re.search(rb"^policies = (\[.*\])$", text, re.MULTILINE)
    if match is not None:
        return json.loads(match.group(1))
    # Any other `policies` line would leave box without its policy files, and failing later.
    if re.search(rb"^\s*policies\s*=", text, re.MULTILINE):
        sys.exit(
            f"{path} has a `policies` line start.py cannot read on Python "
            f"{sys.version_info.major}.{sys.version_info.minor}, which has no tomllib. Deploy "
            "writes it as `policies = [\"a.dw\", ...]` on one line; run agentcore deploy again."
        )
    return []


# box reads a profile's policy files from beside it, so copy the profile and each file its
# `policies` names out of the read-only zip, into this user's folder, outside the workspace.
staged_profile = os.path.join(DIST, "profile.toml")
shutil.copyfile(staged_profile, PROFILE)
policies = staged_policies(staged_profile)
for policy in policies:
    destination = os.path.join(PROFILE_DIR, policy)
    os.makedirs(os.path.dirname(destination), exist_ok=True)
    shutil.copyfile(os.path.join(DIST, policy), destination)

os.chdir(WORKSPACE)
os.execve(
    BOX,
    ["box", "run", PROFILE, "--no-banner"],
    {
        **os.environ,
        "HOME": HOME,
        "BOX_CODE": CODE,
        "BOX_PYTHON": sys.executable,
        "BOX_PYTHON_PREFIX": sys.base_prefix,
    },
)
