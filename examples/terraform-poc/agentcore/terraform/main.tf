# Module implementation is owned by the companion L3 constructs PoC.
module "application" {
  source = "git::https://github.com/jariy17/agentcore-l3-cdk-constructs.git//terraform/modules/agentcore-application?ref=ade47fb93664070aff6a23b714691ca7c10d6f7c"

  spec        = jsondecode(file("${path.module}/../agentcore.json"))
  target_name = var.target_name
  account_id  = var.account_id
  region      = var.region
  artifacts   = jsondecode(file("${path.module}/artifacts.json"))
}
