output "alb_dns_name" {
  value = aws_lb.main.dns_name
}

output "rds_endpoint" {
  value = aws_db_instance.main.endpoint
}

output "redis_endpoint" {
  value = aws_elasticache_replication_group.main.primary_endpoint_address
}

output "ecr_repository_url" {
  value = aws_ecr_repository.api.repository_url
}

output "cloudfront_domain" {
  value = aws_cloudfront_distribution.screenshots.domain_name
}

output "s3_bucket_name" {
  value = aws_s3_bucket.screenshots.id
}

output "acm_certificate_arn" {
  value = aws_acm_certificate.main.arn
}
