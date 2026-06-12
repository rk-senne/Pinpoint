# S3 bucket for screenshots
resource "aws_s3_bucket" "screenshots" {
  bucket = "pinpoint-${var.environment}-screenshots"
  tags   = { Name = "pinpoint-${var.environment}-screenshots" }
}

resource "aws_s3_bucket_versioning" "screenshots" {
  bucket = aws_s3_bucket.screenshots.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "screenshots" {
  bucket = aws_s3_bucket.screenshots.id
  rule { apply_server_side_encryption_by_default { sse_algorithm = "AES256" } }
}

resource "aws_s3_bucket_public_access_block" "screenshots" {
  bucket                  = aws_s3_bucket.screenshots.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# CloudFront for screenshot delivery
resource "aws_cloudfront_origin_access_control" "screenshots" {
  name                              = "pinpoint-${var.environment}-screenshots"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_distribution" "screenshots" {
  enabled             = true
  default_root_object = ""
  price_class         = "PriceClass_100"

  origin {
    domain_name              = aws_s3_bucket.screenshots.bucket_regional_domain_name
    origin_id                = "s3-screenshots"
    origin_access_control_id = aws_cloudfront_origin_access_control.screenshots.id
  }

  default_cache_behavior {
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    target_origin_id       = "s3-screenshots"
    viewer_protocol_policy = "redirect-to-https"
    compress               = true

    forwarded_values {
      query_string = false
      cookies { forward = "none" }
    }

    min_ttl     = 0
    default_ttl = 86400
    max_ttl     = 31536000
  }

  restrictions {
    geo_restriction { restriction_type = "none" }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }

  tags = { Name = "pinpoint-${var.environment}-cdn" }
}

resource "aws_s3_bucket_policy" "screenshots_cloudfront" {
  bucket = aws_s3_bucket.screenshots.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "CloudFrontAccess"
      Effect    = "Allow"
      Principal = { Service = "cloudfront.amazonaws.com" }
      Action    = "s3:GetObject"
      Resource  = "${aws_s3_bucket.screenshots.arn}/*"
      Condition = {
        StringEquals = {
          "AWS:SourceArn" = aws_cloudfront_distribution.screenshots.arn
        }
      }
    }]
  })
}

# ACM certificate
resource "aws_acm_certificate" "main" {
  domain_name               = var.domain_name
  subject_alternative_names = ["*.${var.domain_name}"]
  validation_method         = "DNS"
  lifecycle { create_before_destroy = true }
}
