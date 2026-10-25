# A lab machine for rehearsing backend step 8 (deploy/lab/README.md): Ubuntu 24.04 with systemd and SSH, as the real
# servers. Fake data only; nothing here is a production setting.
FROM ubuntu:24.04
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      systemd systemd-sysv dbus openssh-server sudo python3 python3-apt iproute2 iptables nftables \
      curl ca-certificates gnupg less \
 && rm -rf /var/lib/apt/lists/* \
 && systemctl enable ssh \
 && mkdir -p /root/.ssh && chmod 700 /root/.ssh \
 # No getty on a container console, and no clock or kernel units a container cannot run.
 && systemctl mask getty@tty1.service systemd-timesyncd.service systemd-sysctl.service 2>/dev/null || true
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
