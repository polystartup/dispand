// A Dispand runner: an Ubuntu VM that runs deploy/runner/cloud-init.sh as custom data. No
// managed identity, no secret parameter: SSH with your public key, then pair the runner.
// Compiled to azuredeploy.json (`bicep build main.bicep --outfile azuredeploy.json`), which CI
// checks is up to date.

@description('Where to create the runner; the resource group\'s location by default.')
param location string = resourceGroup().location

@description('The VM size (x64).')
param vmSize string = 'Standard_B2ls_v2'

@description('The admin user to sign in over SSH with.')
param adminUsername string = 'dispand'

@description('Your SSH public key (ssh-ed25519 or ssh-rsa ...).')
param sshPublicKey string

@description('The addresses allowed to reach SSH (yours, such as 203.0.113.7/32).')
param sshSourceAddress string

var name = 'dispand-runner'

resource nsg 'Microsoft.Network/networkSecurityGroups@2024-05-01' = {
  name: '${name}-nsg'
  location: location
  properties: {
    securityRules: [
      {
        name: 'ssh'
        properties: {
          priority: 1000
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefix: sshSourceAddress
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '22'
        }
      }
    ]
  }
}

resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: '${name}-vnet'
  location: location
  properties: {
    addressSpace: { addressPrefixes: ['10.0.0.0/24'] }
    subnets: [
      {
        name: 'default'
        properties: {
          addressPrefix: '10.0.0.0/24'
          networkSecurityGroup: { id: nsg.id }
        }
      }
    ]
  }
}

resource ip 'Microsoft.Network/publicIPAddresses@2024-05-01' = {
  name: '${name}-ip'
  location: location
  sku: { name: 'Standard' }
  properties: { publicIPAllocationMethod: 'Static' }
}

resource nic 'Microsoft.Network/networkInterfaces@2024-05-01' = {
  name: '${name}-nic'
  location: location
  properties: {
    ipConfigurations: [
      {
        name: 'ipconfig'
        properties: {
          subnet: { id: vnet.properties.subnets[0].id }
          publicIPAddress: { id: ip.id }
        }
      }
    ]
  }
}

resource vm 'Microsoft.Compute/virtualMachines@2024-07-01' = {
  name: name
  location: location
  properties: {
    hardwareProfile: { vmSize: vmSize }
    storageProfile: {
      imageReference: {
        publisher: 'Canonical'
        offer: 'ubuntu-24_04-lts'
        sku: 'server'
        version: 'latest'
      }
      osDisk: {
        createOption: 'FromImage'
        diskSizeGB: 30
        managedDisk: { storageAccountType: 'StandardSSD_LRS' }
      }
    }
    osProfile: {
      computerName: name
      adminUsername: adminUsername
      // deploy/runner/cloud-init.sh, inlined at build: CI checks it byte for byte.
      customData: loadFileAsBase64('../cloud-init.sh')
      linuxConfiguration: {
        disablePasswordAuthentication: true
        ssh: {
          publicKeys: [
            {
              path: '/home/${adminUsername}/.ssh/authorized_keys'
              keyData: sshPublicKey
            }
          ]
        }
      }
    }
    networkProfile: { networkInterfaces: [{ id: nic.id }] }
  }
}

output ssh string = 'ssh ${adminUsername}@${ip.properties.ipAddress}'
