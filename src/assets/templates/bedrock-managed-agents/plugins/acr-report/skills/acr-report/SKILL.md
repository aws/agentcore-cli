---
name: acr-report
description: Save a report of the Python version, user ID, and working directory of the ACR in the workspace.
---

Run these commands in the workspace directory:

- `python3 --version`
- `id -u`
- `pwd`

Save the output as `acr-report.txt` in the workspace. The first line of the
file is `# ACR report`, and each command and its output follow it. Read the
file back and report its path.

If a command fails, put its error in the report. Do not change the commands.
