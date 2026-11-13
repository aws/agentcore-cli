# Starts the agent in a box on AgentCore Runtime. The Runtime's entry point must be a .py file, so
# this hands over to start.sh, and tells it which Python the Runtime runs.
import os
import sys

script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "start.sh")
os.execve("/bin/bash", ["bash", script], {**os.environ, "BOX_START_PYTHON": sys.executable})
