output "project_resources" {
  value = module.application.project_resources
  precondition {
    condition     = data.aws_caller_identity.current.account_id == var.account_id
    error_message = "AWS credentials do not match account_id."
  }
}

output "runtimes" {
  value = module.application.runtimes
}

output "memories" {
  value = module.application.memories
}

output "gateways" {
  value = module.application.gateways
}

output "policy_engines" {
  value = module.application.policy_engines
}

output "online_evaluations" {
  value = module.application.online_evaluations
}

output "deployment_target" {
  value = {
    name    = var.target_name
    account = var.account_id
    region  = var.region
  }
}
