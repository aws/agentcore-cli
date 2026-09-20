locals {
  method     = "awscc"
  memory_id  = awscc_bedrockagentcore_memory.history.memory_id
  memory_arn = awscc_bedrockagentcore_memory.history.memory_arn
}

resource "awscc_bedrockagentcore_memory" "history" {
  name                  = "${var.name_prefix}_awscc_history"
  description           = var.description
  event_expiry_duration = var.memory_retention_days
  tags                  = local.tags

  lifecycle {
    precondition {
      condition     = data.aws_caller_identity.current.account_id == var.expected_account_id
      error_message = "The AWS credentials do not match expected_account_id."
    }
  }
}

resource "awscc_bedrockagentcore_runtime" "agent" {
  agent_runtime_name = "${var.name_prefix}_awscc_agent"
  description        = var.description
  role_arn           = aws_iam_role.runtime.arn
  tags               = local.tags

  agent_runtime_artifact = {
    code_configuration = {
      code = {
        s3 = {
          bucket     = aws_s3_bucket.code.id
          prefix     = aws_s3_object.code.key
          version_id = aws_s3_object.code.version_id
        }
      }
      runtime     = "PYTHON_3_12"
      entry_point = var.runtime_entry_point
    }
  }
  network_configuration = {
    network_mode = "PUBLIC"
  }
  protocol_configuration = "HTTP"
  lifecycle_configuration = {
    idle_runtime_session_timeout = 60
    max_lifetime                 = 300
  }
  environment_variables = merge(var.environment_variables, {
    DEPLOYMENT_METHOD           = local.method
    AGENTCORE_MEMORY_HISTORY_ID = local.memory_id
  })
  depends_on = [aws_iam_role_policy.runtime]
}
