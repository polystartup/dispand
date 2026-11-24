#!/usr/bin/env bash
# Boots runner.qcow2 under QEMU (KVM) with a throwaway cloud-init seed holding a fresh SSH key,
# then checks over SSH that gVisor is registered, the supervisor waits for pairing and SSH
# refuses passwords. The supervisor image comes from GHCR. Needs qemu-system-x86_64, qemu-img,
# cloud-localds and ssh-keygen. Usage: boot-check.sh <runner.qcow2>
set -euo pipefail
image="$(realpath "$1")"
work="$(mktemp -d)"
cleanup() {
  [ -f "$work/qemu.pid" ] && kill "$(cat "$work/qemu.pid")" 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT

ssh-keygen -q -t ed25519 -N '' -f "$work/key"
cat >"$work/user-data" <<EOD
#cloud-config
users:
  - name: check
    sudo: ALL=(ALL) NOPASSWD:ALL
    ssh_authorized_keys: ["$(cat "$work/key.pub")"]
EOD
printf 'instance-id: boot-check\n' >"$work/meta-data"
cloud-localds "$work/seed.iso" "$work/user-data" "$work/meta-data"
qemu-img create -q -f qcow2 -b "$image" -F qcow2 "$work/disk.qcow2"
qemu-system-x86_64 -enable-kvm -cpu host -m 4096 -smp 2 -display none -daemonize \
  -pidfile "$work/qemu.pid" -serial "file:$work/console.log" \
  -drive "file=$work/disk.qcow2,if=virtio" -drive "file=$work/seed.iso,media=cdrom" \
  -nic user,hostfwd=tcp:127.0.0.1:2222-:22

on_vm() { ssh -i "$work/key" -p 2222 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=5 -o LogLevel=ERROR check@127.0.0.1 "$@"; }
for _ in $(seq 120); do on_vm true 2>/dev/null && break; sleep 5; done
on_vm true || { cat "$work/console.log" >&2; exit 1; }
# The run-once script (cloud-init.sh) ends before cloud-init reports done.
on_vm sudo cloud-init status --wait || { on_vm sudo cat /var/log/cloud-init-output.log >&2; exit 1; }
on_vm "sudo docker info --format '{{json .Runtimes}}'" | grep -q '"runsc"'
for _ in $(seq 60); do on_vm sudo docker logs dispand-runner 2>&1 | grep -q "not paired yet" && break; sleep 2; done
on_vm sudo docker logs dispand-runner 2>&1 | grep -q "not paired yet"
on_vm sudo sshd -T | grep -qx 'passwordauthentication no'
echo "boot check passed: runsc registered, the supervisor waits for pairing, SSH refuses passwords"
