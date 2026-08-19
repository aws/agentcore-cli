FROM public.ecr.aws/docker/library/python:3.12-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
    git \
    curl \
    jq \
    && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

# Tokens are baked into the image at build time. This image must be treated as a
# secret and stored only in a registry with equivalent access controls.
ARG CLONE_TOKEN
ARG GITHUB_TOKEN

# Configure git to use clone token for HTTPS clones
RUN git config --global url."https://${CLONE_TOKEN}@github.com/".insteadOf "https://github.com/"

# Persist gh CLI auth so GITHUB_TOKEN doesn't need to be in the environment
RUN mkdir -p /root/.config/gh \
    && echo "github.com:" > /root/.config/gh/hosts.yml \
    && echo "  oauth_token: ${GITHUB_TOKEN}" >> /root/.config/gh/hosts.yml \
    && echo "  user: agentcore-cli-automation" >> /root/.config/gh/hosts.yml \
    && echo "  git_protocol: https" >> /root/.config/gh/hosts.yml

WORKDIR /opt/workspace
