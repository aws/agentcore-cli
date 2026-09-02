FROM public.ecr.aws/docker/library/node:22-slim

WORKDIR /app

ENV NODE_ENV=production \
    DOCKER_CONTAINER=1

RUN userdel -r node 2>/dev/null || true
RUN useradd -m -u 1000 bedrock_agentcore

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY --chown=bedrock_agentcore:bedrock_agentcore . .

USER bedrock_agentcore

# AgentCore Runtime service contract ports
# https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-service-contract.html
# 8080: HTTP Mode
# 8000: MCP Mode
# 9000: A2A Mode
EXPOSE 8080 8000 9000

CMD ["npx", "tsx", "main.ts"]
