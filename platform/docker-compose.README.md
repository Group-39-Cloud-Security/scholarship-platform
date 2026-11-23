# docker-compose.yml goes here

Copy the lab's `infra/floci/docker-compose.yml` (cloud-issue-tracker project) into this folder as `docker-compose.yml`,
remove the `app` profile containers (we deploy to Lambda + S3 instead), and make sure the Floci service has:

```yaml
environment:
  FLOCI_STORAGE_MODE: persistent
  FLOCI_SERVICES_IAM_ENFORCEMENT_ENABLED: "true"   # switch on once the first functions work
```
Then delete this README.
