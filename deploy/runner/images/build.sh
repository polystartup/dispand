#!/usr/bin/env bash
# Builds the runner's VM images into <out dir>: runner.qcow2 and runner.ova, from Ubuntu 24.04's
# cloud image with ../cloud-init.sh as a run-once cloud-init script. Nothing else is added: no
# user, no credential. Needs curl, qemu-img and virt-customize (libguestfs); run it as root.
# Usage: build.sh <out dir>
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="$1"
mkdir -p "$out"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

base=https://cloud-images.ubuntu.com/releases/noble/release
img=ubuntu-24.04-server-cloudimg-amd64.img
curl -fsSL -o "$work/$img" "$base/$img"
curl -fsSL -o "$work/SHA256SUMS" "$base/SHA256SUMS"
(cd "$work" && grep " \*$img\$" SHA256SUMS | sha256sum -c -)

qemu-img convert -O qcow2 "$work/$img" "$work/runner.qcow2"
capacity=$((20 << 30)) # 20 GiB, in bytes for the OVF
qemu-img resize "$work/runner.qcow2" "$capacity"
virt-customize -a "$work/runner.qcow2" --no-network \
  --mkdir /var/lib/cloud/scripts/per-once \
  --upload "$here/../cloud-init.sh:/var/lib/cloud/scripts/per-once/dispand-runner.sh" \
  --chmod 0755:/var/lib/cloud/scripts/per-once/dispand-runner.sh \
  --upload "$here/sshd.conf:/etc/ssh/sshd_config.d/10-dispand-runner.conf" \
  --truncate /etc/machine-id # each VM makes its own on first boot

qemu-img convert -c -O qcow2 "$work/runner.qcow2" "$out/runner.qcow2"
qemu-img convert -O vmdk -o subformat=streamOptimized,adapter_type=lsilogic "$work/runner.qcow2" "$work/runner-disk1.vmdk"
sed -e "s/@SIZE@/$(stat -c %s "$work/runner-disk1.vmdk")/" -e "s/@CAPACITY@/$capacity/" "$here/runner.ovf" >"$work/runner.ovf"
# The descriptor comes first in an OVA.
tar -C "$work" --format=ustar -cf "$out/runner.ova" runner.ovf runner-disk1.vmdk
