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
import shutil
import sys

try:
    import tomllib
except ModuleNotFoundError:  # Python 3.10: the template depends on tomli there.
    import tomli as tomllib

CODE = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.join(CODE, ".box-dist")
BOX = os.path.join(DIST, "box")
BOX_HOME = "/tmp/box/home"
WORKSPACE = "/tmp/box/workspace"
PROFILE_DIR = "/tmp/box/profile"
PROFILE = os.path.join(PROFILE_DIR, "profile.toml")

for directory in (BOX_HOME, WORKSPACE, PROFILE_DIR):
    os.makedirs(directory, exist_ok=True)

# box reads a profile's policy files from beside it, so copy the profile and each file its
# `policies` names out of the read-only zip, into this user's folder, outside the workspace.
staged_profile = os.path.join(DIST, "profile.toml")
shutil.copyfile(staged_profile, PROFILE)
with open(staged_profile, "rb") as handle:
    policies = tomllib.load(handle).get("policies", [])
for policy in policies:
    destination = os.path.join(PROFILE_DIR, policy)
    os.makedirs(os.path.dirname(destination), exist_ok=True)
    shutil.copyfile(os.path.join(DIST, policy), destination)

os.chdir(WORKSPACE)
os.environ.update(
    HOME=BOX_HOME,
    BOX_CODE=CODE,
    BOX_PYTHON=sys.executable,
    BOX_PYTHON_PREFIX=sys.base_prefix,
)
with open(os.path.join(DIST, "runtime-start.json"), encoding="utf-8") as handle:
    configuration = json.load(handle)
command = [BOX, "run", PROFILE, "--no-banner"]
if configuration["required_mounts"]:
    # Health checks can run before restore. Import the agent only after its storage is mounted.
    sys.path.insert(0, DIST)
    from box_runtime import serve

    serve(command, configuration["required_mounts"])
else:
    os.execve(BOX, command, os.environ)
