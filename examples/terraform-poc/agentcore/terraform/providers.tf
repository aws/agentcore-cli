terraform {
  backend "local" {
    path = ".targets/default/terraform.tfstate"
  }

  required_version = ">= 1.12.0, < 2.0.0"
  required_providers {
    awscc = {
      source  = "hashicorp/awscc"
      version = "= 1.106.0"
    }
    aws = {
      source  = "hashicorp/aws"
      version = "= 6.69.0"
    }
  }
}

provider "aws" {
  region              = var.region
  allowed_account_ids = [var.account_id]
}

provider "awscc" {
  region = var.region
}

data "aws_caller_identity" "current" {}
