# Public ALB (ADR-020): staff and customers reach one origin. Public ingress
# paths are routed straight to the API; everything else goes to the Next.js
# web app, which is the only thing browsers talk to.
resource "aws_security_group" "alb" {
  name        = "${var.name}-alb"
  description = "OCSO public load balancer"
  vpc_id      = var.vpc_id
  tags        = { Name = "${var.name}-alb" }
}

resource "aws_vpc_security_group_ingress_rule" "https" {
  for_each          = toset(var.ingress_cidrs)
  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = each.value
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  description       = "HTTPS"
}

resource "aws_vpc_security_group_ingress_rule" "http" {
  for_each          = toset(var.ingress_cidrs)
  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = each.value
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
  description       = "HTTP (redirected to HTTPS)"
}

# Only towards targets inside the VPC.
resource "aws_vpc_security_group_egress_rule" "targets" {
  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = var.vpc_cidr_block
  ip_protocol       = "tcp"
  from_port         = 0
  to_port           = 65535
  description       = "To ECS targets"
}

resource "aws_lb" "this" {
  name                       = substr(var.name, 0, 32)
  load_balancer_type         = "application"
  internal                   = false
  security_groups            = [aws_security_group.alb.id]
  subnets                    = var.public_subnet_ids
  idle_timeout               = var.idle_timeout_seconds
  drop_invalid_header_fields = true
  enable_deletion_protection = var.deletion_protection
  desync_mitigation_mode     = "defensive"

  dynamic "access_logs" {
    for_each = var.access_logs_bucket == null ? [] : [var.access_logs_bucket]
    content {
      bucket  = access_logs.value
      prefix  = var.name
      enabled = true
    }
  }
}

resource "aws_lb_target_group" "api" {
  name                 = substr("${var.name}-api", 0, 32)
  port                 = 4000
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = var.vpc_id
  deregistration_delay = 30

  health_check {
    path                = "/health/ready"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

resource "aws_lb_target_group" "web" {
  name                 = substr("${var.name}-web", 0, 32)
  port                 = 3000
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = var.vpc_id
  deregistration_delay = 30

  health_check {
    path                = "/login" # public page; `/` redirects to /login without a session
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = var.ssl_policy
  certificate_arn   = var.certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }
}

# A path-pattern condition takes at most 5 values, so the six public-ingress
# prefixes are split over two rules with the same target.
locals {
  api_path_groups = {
    ingress = ["/channels/*", "/public/*", "/oauth/*", "/.well-known/*", "/blobs/*"]
    health  = ["/health/*"]
  }
}

resource "aws_lb_listener_rule" "api" {
  for_each     = local.api_path_groups
  listener_arn = aws_lb_listener.https.arn
  priority     = each.key == "ingress" ? 10 : 20

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }

  condition {
    path_pattern {
      values = each.value
    }
  }
}
