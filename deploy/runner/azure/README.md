# A runner on Azure

[![Deploy to Azure](https://aka.ms/deploytoazurebutton)](https://portal.azure.com/#create/Microsoft.Template/uri/https%3A%2F%2Fraw.githubusercontent.com%2Fpolystartup%2Fdispand%2Fmain%2Fdeploy%2Frunner%2Fazure%2Fazuredeploy.json)

`main.bicep` (compiled to `azuredeploy.json`, which the button deploys) creates one Ubuntu 24.04
VM (x64) that runs `../cloud-init.sh` as its custom data, in its own virtual network, with a
network security group that only opens SSH to the addresses you give. The runner connects out
to Dispand, so nothing else is open.

- No managed identity: the VM has no Azure identity to lose.
- No secret parameter. You give your SSH public key; password sign-in is off.

## Launch it

Choose the button above, pick a resource group (a new one keeps the runner apart), and give
your SSH public key and the addresses allowed to reach SSH (yours, as `<address>/32`).

Or with the Azure CLI:

```sh
az deployment group create --resource-group <group> --template-file main.bicep \
  --parameters sshPublicKey="$(cat ~/.ssh/id_ed25519.pub)" sshSourceAddress=<address>/32
```

## Pair it

The deployment's `ssh` output is the SSH command. Once the VM is up (cloud-init takes a few
minutes, `cloud-init status --wait` tells when it's done), sign in and follow
[the pairing step](../README.md#pair-it).

Remove it: delete the resource group, then revoke the runner in Dispand.
