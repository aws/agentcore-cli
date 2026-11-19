"""Start the generated Box container, deferring storage-backed HTTP agents until invocation."""
import json
import os
from pathlib import Path

from box_runtime import serve

profile_directory = Path(__file__).resolve().parent
command = ["/opt/box/box", "run", str(profile_directory / "profile.toml"), "--no-banner"]
configuration_file = profile_directory / "runtime-start.json"
# Local development stages no Runtime storage metadata and retains eager startup.
configuration = json.loads(configuration_file.read_text()) if configuration_file.exists() else {}
if configuration.get("required_mounts"):
    serve(command, configuration["required_mounts"])
else:
    os.execve(command[0], command, os.environ)
