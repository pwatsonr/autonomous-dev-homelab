#!/bin/sh
set -e
ssh-keygen -A
# CA pubkey and KRL are mounted in via -v
test -f /etc/ssh/homelab_ca.pub || { echo "Missing CA pubkey mount"; exit 1; }
test -f /etc/ssh/homelab_ca.krl || touch /etc/ssh/homelab_ca.krl
exec /usr/sbin/sshd -D -e
