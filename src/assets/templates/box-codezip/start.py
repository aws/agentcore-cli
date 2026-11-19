# Runs the agent in a box on AgentCore Runtime (CodeZip). The Runtime's entry point must be a .py
# file, so this prepares a writable HOME and workspace, copies the box profile out of the read-only
# zip into a folder this user owns (box runs only a profile its user owns), exports the Python and
# code paths that only the microVM knows, and hands over to `box run`.
#
# The box profile reads the deployed resources, the gateway URL, the Python interpreter and the code
# directory from the environment through the box/agentcore and box/agentcore-codezip packs, and
# signs AWS routes with the execution role through a bare `aws://`. So there is nothing to fill in,
# no credentials to write, and no start.sh.
import os
import shutil
import sys

CODE = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.join(CODE, ".box-dist")
BOX = os.path.join(DIST, "box")
HOME = "/tmp/box/home"
WORKSPACE = "/tmp/box/workspace"
PROFILE_DIR = "/tmp/box/profile"
PROFILE = os.path.join(PROFILE_DIR, "profile.toml")

# The names of box's own interpreter aliases. box refuses a stdio MCP server whose program has one
# of these names, so a server on the Runtime's Python needs that Python by its versioned name.
INTERPRETER_ALIASES = ("python", "python3")


def box_python(executable, version):
    """The Runtime's Python, `executable`, by a name that is not an interpreter alias of box: its
    versioned file beside it (python3.12), else the file it links to, else `executable` itself."""
    if os.path.basename(executable) not in INTERPRETER_ALIASES:
        return executable
    versioned = os.path.join(os.path.dirname(executable), f"python{version[0]}.{version[1]}")
    if os.path.isfile(versioned) and os.access(versioned, os.X_OK):
        return versioned
    linked = os.path.realpath(executable)
    if os.path.basename(linked) not in INTERPRETER_ALIASES:
        return linked
    return executable


def main():
    try:
        import tomllib
    except ModuleNotFoundError:  # Python 3.10: the template depends on tomli there.
        import tomli as tomllib

    for directory in (HOME, WORKSPACE, PROFILE_DIR):
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
    os.execve(
        BOX,
        ["box", "run", PROFILE, "--no-banner"],
        {
            **os.environ,
            "HOME": HOME,
            "BOX_CODE": CODE,
            "BOX_PYTHON": box_python(sys.executable, sys.version_info),
            "BOX_PYTHON_PREFIX": sys.base_prefix,
        },
    )


if __name__ == "__main__":
    main()
