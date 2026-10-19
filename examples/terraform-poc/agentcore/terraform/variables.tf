variable "account_id" {
  type        = string
  description = "Expected deployment account."
  validation {
    condition     = can(regex("^[0-9]{12}$", var.account_id))
    error_message = "account_id must contain 12 digits."
  }
}

variable "region" {
  type    = string
  default = "us-west-2"
}

variable "target_name" {
  type    = string
  default = "default"
}
