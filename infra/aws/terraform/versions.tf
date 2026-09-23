# OCSO on AWS (ADR-022). Terraform >= 1.11 is required for write-only
# attributes (`password_wo`, `secret_string_wo`), which keep the database
# password and bootstrap secrets out of the Terraform state.
terraform {
  required_version = ">= 1.11.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.7" # 3.7 added the ephemeral random_password
    }
  }

  # Remote state (recommended). Create the bucket once, out of band, with
  # versioning + SSE-KMS + Block Public Access, then uncomment and run
  # `terraform init -migrate-state`. `use_lockfile` uses S3 conditional writes
  # for locking (no DynamoDB table).
  #
  # backend "s3" {
  #   bucket       = "acme-terraform-state"
  #   key          = "ocso/prod/terraform.tfstate"
  #   region       = "ap-south-1"
  #   encrypt      = true
  #   use_lockfile = true
  # }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = merge(var.tags, {
      "app"         = var.name
      "environment" = var.environment
      "managed-by"  = "terraform"
    })
  }
}
