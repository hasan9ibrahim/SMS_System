#!/usr/bin/env bash
# The step 8 rehearsal lab (deploy/lab/README.md): three Ubuntu 24.04 machines with systemd on one docker network,
# reached over SSH like the real servers, plus S3 storage standing in for the off-site S3 storage.
#
#   lab.sh up              build the image, start srv-a, srv-b, witness and s3
#   lab.sh down            remove them (and their data)
#   lab.sh ssh <machine>   a shell on a machine
#   lab.sh cut <a> <b>     cut the network between two machines (both directions)
#   lab.sh heal            remove every cut
#   lab.sh poweroff <m>    stop a machine at once (a server losing power); lab.sh start <m> starts it again
#
# LAB_CA_FILE: a CA bundle the machines should also trust (a network that inspects HTTPS through a proxy).
# LAB_HTTPS_PROXY: a proxy the machines must use to reach the internet (e.g. http://10.88.0.1:3128).
set -euo pipefail
cd "$(dirname "$0")"
NET=sms-lab
SUBNET=10.88.0.0/24
declare -A IP=([srv-a]=10.88.0.11 [srv-b]=10.88.0.12 [witness]=10.88.0.13 [s3]=10.88.0.20)
KEY=.ssh/id_ed25519

machine() { [[ -n "${IP[$1]:-}" && "$1" != s3 ]] || { echo "unknown machine: $1" >&2; exit 2; }; }

case "${1:-}" in
  up)
    mkdir -p .ssh && [[ -f $KEY ]] || ssh-keygen -q -t ed25519 -N "" -f $KEY -C sms-lab
    docker build -q -t sms-lab-node . >/dev/null
    docker network inspect $NET >/dev/null 2>&1 || docker network create --subnet $SUBNET $NET >/dev/null
    for m in srv-a srv-b witness; do
      docker inspect "lab-$m" >/dev/null 2>&1 && continue
      docker run -d --name "lab-$m" --hostname "$m" --network $NET --ip "${IP[$m]}" \
        --privileged --cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw --tmpfs /run --tmpfs /run/lock \
        sms-lab-node >/dev/null
      docker exec -i "lab-$m" sh -c "cat > /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys" < $KEY.pub
    done
    if [[ -n "${LAB_HTTPS_PROXY:-}" ]]; then
      no_proxy="localhost,127.0.0.1,${IP[srv-a]},${IP[srv-b]},${IP[witness]},${IP[s3]}"
      for m in srv-a srv-b witness; do
        docker exec -i "lab-$m" sh -c "cat > /etc/environment && printf 'Acquire::https::Proxy \"%s\";\n' \
          '$LAB_HTTPS_PROXY' > /etc/apt/apt.conf.d/90lab-proxy" <<ENV
PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
https_proxy=$LAB_HTTPS_PROXY
no_proxy=$no_proxy
ENV
      done
    fi
    if [[ -n "${LAB_CA_FILE:-}" ]]; then
      for m in srv-a srv-b witness; do
        docker exec -i "lab-$m" sh -c "cat > /usr/local/share/ca-certificates/lab-extra.crt && update-ca-certificates >/dev/null 2>&1" \
          < "$LAB_CA_FILE"
      done
    fi
    # S3 storage with a self-signed certificate (pgBackRest speaks S3 only over TLS). SeaweedFS's S3 gateway stands in
    # for the off-site provider; MinIO no longer publishes images or binaries.
    if ! docker inspect lab-s3 >/dev/null 2>&1; then
      mkdir -p s3
      [[ -f s3/public.crt ]] || openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=s3" \
        -addext "subjectAltName=IP:${IP[s3]},DNS:s3" -keyout s3/private.key -out s3/public.crt 2>/dev/null
      cat > s3/s3.json <<JSON
{"identities": [{"name": "lab", "credentials": [{"accessKey": "labbackup", "secretKey": "lab-only-s3-secret"}],
  "actions": ["Admin", "Read", "List", "Tagging", "Write"]}]}
JSON
      docker run -d --name lab-s3 --hostname s3 --network $NET --ip "${IP[s3]}" -v "$PWD/s3:/etc/s3:ro" \
        chrislusf/seaweedfs:3.80 server -dir=/data -master.volumePreallocate=false -master.volumeSizeLimitMB=64 \
        -s3 -s3.port=9000 -s3.config=/etc/s3/s3.json \
        -s3.cert.file=/etc/s3/public.crt -s3.key.file=/etc/s3/private.key >/dev/null
      # The bucket, as created by hand at the provider in production.
      for i in $(seq 1 30); do
        docker exec lab-s3 sh -c 'echo "s3.bucket.create -name sms-backups" | weed shell' >/dev/null 2>&1
        docker exec lab-s3 sh -c 'echo s3.bucket.list | weed shell' 2>/dev/null | grep -q sms-backups && break
        sleep 1
      done
    fi
    for m in srv-a srv-b witness; do
      for i in $(seq 1 30); do
        ssh -q -i $KEY -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=2 \
          "root@${IP[$m]}" true && break
        sleep 1
      done
    done
    echo "lab up: srv-a ${IP[srv-a]}, srv-b ${IP[srv-b]}, witness ${IP[witness]}, s3 https://${IP[s3]}:9000"
    ;;
  down)
    docker rm -f lab-srv-a lab-srv-b lab-witness lab-s3 >/dev/null 2>&1 || true
    docker network rm $NET >/dev/null 2>&1 || true
    ;;
  ssh)
    machine "$2"
    exec ssh -i $KEY -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null "root@${IP[$2]}" "${@:3}"
    ;;
  cut)
    machine "$2"; machine "$3"
    docker exec "lab-$2" iptables -I INPUT -s "${IP[$3]}" -j DROP
    docker exec "lab-$2" iptables -I OUTPUT -d "${IP[$3]}" -j DROP
    docker exec "lab-$3" iptables -I INPUT -s "${IP[$2]}" -j DROP
    docker exec "lab-$3" iptables -I OUTPUT -d "${IP[$2]}" -j DROP
    echo "cut $2 <-> $3"
    ;;
  heal)
    for m in srv-a srv-b witness; do
      for ip in "${IP[@]}"; do
        while docker exec "lab-$m" iptables -D INPUT -s "$ip" -j DROP 2>/dev/null; do :; done
        while docker exec "lab-$m" iptables -D OUTPUT -d "$ip" -j DROP 2>/dev/null; do :; done
      done
    done
    echo healed
    ;;
  poweroff)
    machine "$2"; docker kill "lab-$2" >/dev/null; echo "$2 off"
    ;;
  start)
    machine "$2"; docker start "lab-$2" >/dev/null; echo "$2 starting"
    ;;
  *)
    sed -n '2,12p' "$0"; exit 2
    ;;
esac
