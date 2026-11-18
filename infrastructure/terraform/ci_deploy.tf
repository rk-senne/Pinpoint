# Managed policy for the CI principal (the IAM user/role behind the
# AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY secrets used by
# .github/workflows/deploy-*.yml). This module does NOT create that principal
# or attach the policy: attach `ci_deploy_policy_arn` to it out of band
# (or to an OIDC role, which is preferable to long-lived keys).
#
# Covers exactly what the workflows do:
#   - push the image to ECR (docker/build-push-action after amazon-ecr-login)
#   - infrastructure/scripts/ecs-migrate.sh: describe the service + task
#     definition, ecs:RunTask a one-off task, wait for it (DescribeTasks)
#   - `aws ecs update-service --force-new-deployment` / `services-stable`
#     and the production rollback (`update-service --task-definition`)
#   - iam:PassRole for the task execution + task roles, which RunTask and
#     UpdateService to a new task definition require.
data "aws_caller_identity" "current" {}

locals {
  ecs_arn_prefix = "arn:aws:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}"
}

resource "aws_iam_policy" "ci_deploy" {
  name        = "pinpoint-${var.environment}-ci-deploy"
  description = "CI deploy: ECR push, ECS migrate one-off task, service update"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "EcrLogin"
        Effect   = "Allow"
        Action   = ["ecr:GetAuthorizationToken"]
        Resource = "*"
      },
      {
        Sid    = "EcrPush"
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:BatchGetImage",
          "ecr:CompleteLayerUpload",
          "ecr:GetDownloadUrlForLayer",
          "ecr:InitiateLayerUpload",
          "ecr:PutImage",
          "ecr:UploadLayerPart",
        ]
        Resource = aws_ecr_repository.api.arn
      },
      {
        # Describe* actions do not support resource-level permissions.
        Sid    = "EcsRead"
        Effect = "Allow"
        Action = [
          "ecs:DescribeServices",
          "ecs:DescribeTaskDefinition",
          "ecs:DescribeTasks",
        ]
        Resource = "*"
      },
      {
        Sid      = "EcsUpdateService"
        Effect   = "Allow"
        Action   = ["ecs:UpdateService"]
        Resource = aws_ecs_service.api.id
      },
      {
        # Migration one-off task. Task-definition ARNs are versioned, so the
        # family wildcard covers every revision.
        Sid      = "EcsRunMigrationTask"
        Effect   = "Allow"
        Action   = ["ecs:RunTask"]
        Resource = "${local.ecs_arn_prefix}:task-definition/${aws_ecs_task_definition.api.family}:*"
        Condition = {
          ArnEquals = { "ecs:cluster" = aws_ecs_cluster.main.arn }
        }
      },
      {
        Sid    = "PassTaskRoles"
        Effect = "Allow"
        Action = ["iam:PassRole"]
        Resource = [
          aws_iam_role.ecs_task_execution.arn,
          aws_iam_role.ecs_task.arn,
        ]
        Condition = {
          StringEquals = { "iam:PassedToService" = "ecs-tasks.amazonaws.com" }
        }
      },
    ]
  })
}

output "ci_deploy_policy_arn" {
  description = "Attach this to the CI principal used by the deploy workflows."
  value       = aws_iam_policy.ci_deploy.arn
}
