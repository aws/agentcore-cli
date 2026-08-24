FROM public.ecr.aws/docker/library/python:3.12-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
    git \
    curl \
    jq \
    && rm -rf /var/lib/apt/lists/*

# The clone token is baked into the image. This image must be treated as a secret
# and stored only in a registry with equivalent access controls.
ARG CLONE_TOKEN

# Configure git to use clone token for HTTPS clones
RUN git config --global url."https://${CLONE_TOKEN}@github.com/".insteadOf "https://github.com/"

WORKDIR /opt/workspace
