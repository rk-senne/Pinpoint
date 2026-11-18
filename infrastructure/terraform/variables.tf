variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "environment" {
  type    = string
  default = "staging"
}

variable "domain_name" {
  type        = string
  description = "Primary domain (e.g., pinpoint.app)"
}

variable "db_password" {
  type      = string
  sensitive = true
}

variable "jwt_secret" {
  type      = string
  sensitive = true
}

variable "integration_encryption_key" {
  type        = string
  sensitive   = true
  description = "32-byte key (base64 or 64-char hex) that encrypts integration OAuth tokens + client secrets at rest (Mission A4/A5b)."
}

variable "oauth_state_secret" {
  type        = string
  sensitive   = true
  description = "HMAC key (>= 32 random bytes, e.g. `openssl rand -base64 48`) that signs the OAuth state cookie; required by the production config preflight."
  validation {
    condition     = length(var.oauth_state_secret) >= 32
    error_message = "oauth_state_secret must be at least 32 characters."
  }
}

variable "metrics_token" {
  type        = string
  sensitive   = true
  description = "Bearer token required by GET /metrics (`openssl rand -base64 32`). Without it the endpoint is reachable by anyone who can reach the ALB."
  validation {
    condition     = length(var.metrics_token) >= 24
    error_message = "metrics_token must be at least 24 characters."
  }
}

variable "db_instance_class" {
  type    = string
  default = "db.t3.medium"
}

variable "ecs_cpu" {
  type    = number
  default = 512
}

variable "ecs_memory" {
  type    = number
  default = 1024
}

variable "desired_count" {
  type    = number
  default = 2
}

variable "redis_node_type" {
  type    = string
  default = "cache.t3.micro"
}
