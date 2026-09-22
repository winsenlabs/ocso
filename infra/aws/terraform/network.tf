module "network" {
  source             = "./modules/network"
  name               = local.prefix
  region             = var.aws_region
  cidr_block         = var.vpc_cidr
  az_count           = var.az_count
  single_nat_gateway = var.single_nat_gateway
}

# ---------------------------------------------------------------------------
# Task security groups live outside the service module so RDS can reference
# them before any service (and task) exists.
#   ALB  → web:3000, api:4000
#   web  → api:4000 (Service Connect)
#   api, worker, migrate → RDS:5432 (rule in the rds module)
# Egress is open: model providers, MCP servers and AWS APIs are reached over
# the internet via NAT; destination policy (SSRF guard, allowlists) is
# enforced by OCSO in code (docs/15 §5).
# ---------------------------------------------------------------------------
resource "aws_security_group" "task" {
  for_each    = toset(["api", "web", "worker", "migrate"])
  name        = "${local.prefix}-${each.key}"
  description = "OCSO ${each.key} tasks"
  vpc_id      = module.network.vpc_id
  tags        = { Name = "${local.prefix}-${each.key}" }
}

resource "aws_vpc_security_group_egress_rule" "task_all" {
  for_each          = aws_security_group.task
  security_group_id = each.value.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
  description       = "Outbound (AWS APIs, providers, MCP servers)"
}

resource "aws_vpc_security_group_ingress_rule" "alb_to_web" {
  security_group_id            = aws_security_group.task["web"].id
  referenced_security_group_id = module.alb.security_group_id
  ip_protocol                  = "tcp"
  from_port                    = 3000
  to_port                      = 3000
  description                  = "ALB to web"
}

resource "aws_vpc_security_group_ingress_rule" "alb_to_api" {
  security_group_id            = aws_security_group.task["api"].id
  referenced_security_group_id = module.alb.security_group_id
  ip_protocol                  = "tcp"
  from_port                    = 4000
  to_port                      = 4000
  description                  = "ALB to api (public ingress paths)"
}

resource "aws_vpc_security_group_ingress_rule" "web_to_api" {
  security_group_id            = aws_security_group.task["api"].id
  referenced_security_group_id = aws_security_group.task["web"].id
  ip_protocol                  = "tcp"
  from_port                    = 4000
  to_port                      = 4000
  description                  = "web BFF to api via Service Connect"
}
