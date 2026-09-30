FROM public.ecr.aws/lambda/microvms:al2023-minimal

# OS setup
RUN dnf install -y tar gzip findutils shadow-utils ca-certificates \
 && dnf clean all \
 && useradd -m -u 1000 app

# Codex
RUN curl -fsSL https://chatgpt.com/codex/install.sh -o /tmp/install-codex.sh \
 && CODEX_NON_INTERACTIVE=1 CODEX_INSTALL_DIR=/opt/bma/bin CODEX_HOME=/opt/bma/codex \
    sh /tmp/install-codex.sh \
 && chmod -R a+rX /opt/bma \
 && rm /tmp/install-codex.sh

# CloudWatch agent
RUN arch=$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/') \
 && curl -fsSL -o /tmp/cwagent.rpm \
    https://amazoncloudwatch-agent.s3.amazonaws.com/amazon_linux/${arch}/latest/amazon-cloudwatch-agent.rpm \
 && rpm -i /tmp/cwagent.rpm \
 && rm /tmp/cwagent.rpm

# uv and Python
COPY --from=ghcr.io/astral-sh/uv:latest /uv /bin/
ARG UV_DEFAULT_INDEX
ARG UV_INDEX
ENV UV_PYTHON_INSTALL_DIR=/opt/python UV_PYTHON_BIN_DIR=/usr/local/bin
RUN uv python install --default

# Application. The layout of /opt/bma is the same as the layout of this directory.
WORKDIR /opt/bma
ENV UV_COMPILE_BYTECODE=1 UV_NO_PROGRESS=1 \
    UV_DEFAULT_INDEX=${UV_DEFAULT_INDEX} UV_INDEX=${UV_INDEX}
COPY pyproject.toml uv.lock* ./
RUN uv sync --no-dev
COPY lifecycle/ lifecycle/
COPY otel/ otel/
COPY plugins/ plugins/
USER app

EXPOSE 8080
CMD ["uv", "run", "--no-sync", "opentelemetry-instrument", "python", "-u", "lifecycle/server.py"]
