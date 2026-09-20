locals {
  method     = "native"
  memory_id  = aws_bedrockagentcore_memory.history.id
  memory_arn = aws_bedrockagentcore_memory.history.arn
}

resource "aws_bedrockagentcore_memory" "history" {
  name                  = "${var.name_prefix}_native_history"
  description           = var.description
  event_expiry_duration = var.memory_retention_days
  tags                  = local.tags
}

resource "aws_bedrockagentcore_agent_runtime" "agent" {
  agent_runtime_name = "${var.name_prefix}_native_agent"
  description        = var.description
  role_arn           = aws_iam_role.runtime.arn
  tags               = local.tags

  agent_runtime_artifact {
    code_configuration {
      code {
        s3 {
          bucket     = aws_s3_bucket.code.id
          prefix     = aws_s3_object.code.key
          version_id = aws_s3_object.code.version_id
        }
      }
      runtime     = "PYTHON_3_12"
      entry_point = var.runtime_entry_point
    }
  }
  network_configuration {
    network_mode = "PUBLIC"
  }
  protocol_configuration {
    server_protocol = "HTTP"
  }
  lifecycle_configuration = [{
    idle_runtime_session_timeout = 60
    max_lifetime                 = 300
  }]
  environment_variables = merge(var.environment_variables, {
    DEPLOYMENT_METHOD           = local.method
    AGENTCORE_MEMORY_HISTORY_ID = local.memory_id
  })
  depends_on = [aws_iam_role_policy.runtime]
}
