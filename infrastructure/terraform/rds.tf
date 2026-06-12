# RDS PostgreSQL (Multi-AZ)
resource "aws_db_subnet_group" "main" {
  name       = "pinpoint-${var.environment}"
  subnet_ids = aws_subnet.private[*].id
  tags       = { Name = "pinpoint-${var.environment}-db-subnet" }
}

resource "aws_security_group" "db" {
  name_prefix = "pinpoint-${var.environment}-db-"
  vpc_id      = aws_vpc.main.id

  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.ecs.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "pinpoint-${var.environment}-db-sg" }
}

resource "aws_db_instance" "main" {
  identifier     = "pinpoint-${var.environment}"
  engine         = "postgres"
  engine_version = "16.3"
  instance_class = var.db_instance_class

  allocated_storage     = 20
  max_allocated_storage = 100
  storage_encrypted     = true

  db_name  = "pinpoint"
  username = "pinpoint"
  password = var.db_password

  multi_az               = var.environment == "production"
  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.db.id]

  backup_retention_period = 7
  skip_final_snapshot     = var.environment != "production"
  final_snapshot_identifier = var.environment == "production" ? "pinpoint-final-${formatdate("YYYY-MM-DD", timestamp())}" : null
  deletion_protection     = var.environment == "production"

  tags = { Name = "pinpoint-${var.environment}-db" }
}
