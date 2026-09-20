variable "region" {
  description = "AWS region in which to deploy AgentCore."
  type        = string
  default     = "us-west-2"
}

variable "expected_account_id" {
  description = "AWS account that these credentials must belong to."
  type        = string
  validation {
    condition     = can(regex("^[0-9]{12}$", var.expected_account_id))
    error_message = "Set expected_account_id to your 12-digit AWS account ID."
  }
}

variable "name_prefix" {
  description = "Unique deployment prefix; use a different prefix for each example."
  type        = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9]{2,19}$", var.name_prefix))
    error_message = "Use 3-20 lowercase letters or digits, starting with a letter."
  }
}

variable "description" {
  description = "Description applied to the Runtime and Memory."
  type        = string
  default     = "AgentCore Terraform example"
}

variable "runtime_zip_path" {
  description = "Optional path to your Linux ARM64 Python ZIP. The default is dist/agent.zip."
  type        = string
  default     = null
}

variable "runtime_entry_point" {
  description = "Command used to start the Python application inside the ZIP."
  type        = list(string)
  default     = ["agent.py"]
}

variable "environment_variables" {
  description = "Additional runtime variables. The example's memory ID and deployment method are reserved."
  type        = map(string)
  default     = {}
}

variable "tags" {
  description = "Tags applied to the example resources."
  type        = map(string)
  default     = { Project = "agentcore-terraform" }
}

variable "memory_retention_days" {
  description = "Short-term Memory retention in days; this provider accepts 3-365."
  type        = number
  default     = 3
  validation {
    condition     = var.memory_retention_days >= 3 && var.memory_retention_days <= 365 && floor(var.memory_retention_days) == var.memory_retention_days
    error_message = "Memory retention must be an integer from 3 to 365 days."
  }
}
