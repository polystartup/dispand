# A runner on AWS

`runner.yaml` is a CloudFormation template: one Ubuntu 24.04 instance (amd64) that runs
`../cloud-init.sh` as its user data, and a security group that only opens SSH to the
addresses you give. The runner connects out to Dispand, so nothing else is open.

- IMDSv2 only, with a hop limit of 1, so containers can't reach the metadata service.
- No instance role: the instance has no AWS identity to lose.
- No secret parameter. The key pair is named, never uploaded, and the user data holds no secret.

## Launch it

In the CloudFormation console, choose **Create stack**, then **Upload a template file**, and
pick `runner.yaml`. Give it your key pair, the addresses allowed to reach SSH (yours, as
`<address>/32`) and, if you want, another amd64 instance type.

A one-click Launch Stack link needs the template hosted in S3, which we don't do yet.

Or with the AWS CLI:

```sh
aws cloudformation create-stack --stack-name dispand-runner --template-body file://runner.yaml \
  --parameters ParameterKey=KeyName,ParameterValue=<key pair> ParameterKey=SshCidr,ParameterValue=<address>/32
```

## Pair it

The stack's `Pair` output is the SSH command. Once the instance is up (cloud-init takes a
few minutes, `cloud-init status --wait` tells when it's done), sign in and follow
[the pairing step](../README.md#pair-it).

## Change it

Don't update the stack: CloudFormation then looks up Canonical's current Ubuntu image again, and
a newer one replaces the instance, with the runner's pairing and CLI logins. To change who can
reach SSH, edit the inbound rules of the stack's security group directly.

The template uses the region's default VPC and subnet, which must assign public IPv4 addresses.

Remove it: delete the stack, then revoke the runner in Dispand.
