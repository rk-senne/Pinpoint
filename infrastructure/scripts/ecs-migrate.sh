#!/usr/bin/env bash
# Run `npm run migrate` as a one-off ECS task inside the VPC, using the
# service's current task definition (same image, env and secrets as the API)
# and its network configuration. GitHub-hosted runners cannot reach the
# private-subnet RDS instance, so migrations must run from inside the VPC.
#
# Usage: ECS_CLUSTER=... ECS_SERVICE=... ./infrastructure/scripts/ecs-migrate.sh [task-definition-arn]
# Exits non-zero if the task fails to start or the container exits non-zero.
set -euo pipefail
: "${ECS_CLUSTER:?}" "${ECS_SERVICE:?}"

svc=$(aws ecs describe-services --cluster "$ECS_CLUSTER" --services "$ECS_SERVICE" --query 'services[0]' --output json)
task_def=${1:-$(jq -r '.taskDefinition' <<<"$svc")}
net=$(jq -c '.networkConfiguration' <<<"$svc")
container=$(aws ecs describe-task-definition --task-definition "$task_def" \
  --query 'taskDefinition.containerDefinitions[0].name' --output text)

echo "Running migrations with $task_def (container: $container)"
task_arn=$(aws ecs run-task \
  --cluster "$ECS_CLUSTER" \
  --task-definition "$task_def" \
  --launch-type FARGATE \
  --network-configuration "$net" \
  --overrides "{\"containerOverrides\":[{\"name\":\"$container\",\"command\":[\"npm\",\"run\",\"migrate\"]}]}" \
  --started-by "github-migrate" \
  --query 'tasks[0].taskArn' --output text)

if [[ -z "$task_arn" || "$task_arn" == "None" ]]; then
  echo "Failed to start migration task" >&2
  exit 1
fi

aws ecs wait tasks-stopped --cluster "$ECS_CLUSTER" --tasks "$task_arn"
exit_code=$(aws ecs describe-tasks --cluster "$ECS_CLUSTER" --tasks "$task_arn" \
  --query 'tasks[0].containers[0].exitCode' --output text)
echo "Migration task exit code: $exit_code"
[[ "$exit_code" == "0" ]]
