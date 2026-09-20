terraform {
  required_version = ">= 1.10, < 2.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.65.0"
    }
    awscc = {
      source  = "hashicorp/awscc"
      version = "1.102.0"
    }
  }
}

provider "aws" {
  region              = var.region
  allowed_account_ids = [var.expected_account_id]
}

# Both providers resolve the same environment/default credential chain.
provider "awscc" {
  region = var.region
}
