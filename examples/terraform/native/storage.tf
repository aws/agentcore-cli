locals {
  artifact_path = abspath(coalesce(var.runtime_zip_path, "${path.module}/dist/agent.zip"))
  tags          = merge(var.tags, { DeploymentMethod = local.method })
}

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

resource "aws_s3_bucket" "code" {
  bucket        = "${var.name_prefix}-${local.method}-${data.aws_caller_identity.current.account_id}-${var.region}"
  force_destroy = false
  tags          = local.tags
}

resource "aws_s3_bucket_public_access_block" "code" {
  bucket                  = aws_s3_bucket.code.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "code" {
  bucket = aws_s3_bucket.code.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "code" {
  bucket = aws_s3_bucket.code.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_object" "code" {
  bucket      = aws_s3_bucket.code.id
  key         = "artifacts/${filesha256(local.artifact_path)}.zip"
  source      = local.artifact_path
  source_hash = filesha256(local.artifact_path)
  tags        = local.tags
  depends_on = [
    aws_s3_bucket_versioning.code,
    aws_s3_bucket_public_access_block.code,
    aws_s3_bucket_server_side_encryption_configuration.code
  ]
}
