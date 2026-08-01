# ElastiCache Redis (for Socket.IO adapter + rate limiting)
resource "aws_elasticache_subnet_group" "main" {
  name       = "pinpoint-${var.environment}"
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_security_group" "redis" {
  name_prefix = "pinpoint-${var.environment}-redis-"
  vpc_id      = aws_vpc.main.id

  ingress {
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [aws_security_group.ecs.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "pinpoint-${var.environment}-redis-sg" }
}

resource "aws_elasticache_replication_group" "main" {
  replication_group_id = "pinpoint-${var.environment}"
  description          = "Pinpoint ${var.environment} Redis"
  node_type            = var.redis_node_type
  num_cache_clusters   = var.environment == "production" ? 2 : 1
  port                 = 6379
  subnet_group_name    = aws_elasticache_subnet_group.main.name
  security_group_ids   = [aws_security_group.redis.id]
  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  automatic_failover_enabled = var.environment == "production"

  tags = { Name = "pinpoint-${var.environment}-redis" }
}
