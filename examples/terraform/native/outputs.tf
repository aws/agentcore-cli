output "runtime_id" {
  description = "AgentCore Runtime ID."
  value       = aws_bedrockagentcore_agent_runtime.agent.agent_runtime_id
}

output "runtime_arn" {
  description = "AgentCore Runtime ARN for invocation."
  value       = aws_bedrockagentcore_agent_runtime.agent.agent_runtime_arn
}

output "memory_id" {
  description = "Memory ID supplied to the runtime environment."
  value       = local.memory_id
}

output "memory_arn" {
  description = "AgentCore Memory ARN."
  value       = local.memory_arn
}

output "artifact_bucket" {
  description = "Versioned bucket holding the runtime ZIP."
  value       = aws_s3_bucket.code.id
}
