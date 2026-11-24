# Runner VM images

Each release has two VM images of a runner, built by `build.sh`: `runner.qcow2` (KVM
hypervisors) and `runner.ova` (ESXi, Synology Virtual Machine Manager). Both are Ubuntu 24.04
(x64) with `../cloud-init.sh` as a run-once cloud-init script: on first boot it installs Docker
and gVisor and starts the supervisor, which waits for pairing. Give the VM 2 vCPUs, 4 GiB of
memory, its 20 GiB disk and a network with Internet access.

The images hold no user and no credential, and SSH refuses passwords. You give your SSH key
through cloud-init when you create the VM:

- **KVM hypervisors with a cloud-init drive**: import `runner.qcow2` as the VM's disk, add a
  cloud-init drive, and set a user and your SSH public key on it.
- **ESXi, Synology Virtual Machine Manager and others**: deploy `runner.ova` (or import
  `runner.qcow2`), then attach a seed ISO as the CD-ROM. Make it from a `user-data` file:

  ```yaml
  #cloud-config
  users:
    - name: dispand
      sudo: ALL=(ALL) NOPASSWD:ALL
      ssh_authorized_keys: ["ssh-ed25519 AAAA... you@example.com"]
  ```

  with `printf 'instance-id: dispand-runner\n' > meta-data` and
  `cloud-localds seed.iso user-data meta-data` (from `cloud-image-utils`).

Without a cloud-init source, the VM doesn't set itself up. Once it is up
(`cloud-init status --wait` tells when it's done), sign in over SSH and follow
[the pairing step](../README.md#pair-it).

CI boots `runner.qcow2` under QEMU on every change (`boot-check.sh`): `runsc` is registered,
the supervisor waits for pairing, and SSH refuses passwords.
