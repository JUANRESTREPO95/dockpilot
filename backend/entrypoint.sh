#!/bin/bash
set -e

DATA_DIR="${DATA_DIR:-/data}"
APP_UID="${APP_UID:-10001}"
APP_GID="${APP_GID:-10001}"

# IP del host (excluyendo IPs de Docker)
get_host_ip() {
    for ip in $(hostname -I 2>/dev/null); do
        case "$ip" in
            127.*|172.1[7-9].*|172.2[0-9].*|172.3[0-1].*) continue ;;
        esac
        echo "$ip"
        return
    done
    echo "127.0.0.1"
}

if [ -z "${HOST_IP:-}" ]; then
    HOST_IP="$(get_host_ip)"
fi
export HOST_IP
echo "Host IP detectada: $HOST_IP"

# Volumen de datos escribible por el usuario sin privilegios
mkdir -p "$DATA_DIR" 2>/dev/null || true
chown -R "$APP_UID:$APP_GID" "$DATA_DIR" 2>/dev/null || true

# Grupo del socket de Docker: se pasa como grupo suplementario sin tocar /etc/group
SOCK_GID=""
if [ -S /var/run/docker.sock ]; then
    SOCK_GID="$(stat -c '%g' /var/run/docker.sock 2>/dev/null || true)"
fi

if [ -n "$SOCK_GID" ] && [ "$SOCK_GID" != "0" ]; then
    exec setpriv --reuid="$APP_UID" --regid="$APP_GID" --groups="$SOCK_GID" "$@"
fi

# Socket sin grupo propio (o inexistente): no se puede bajar privilegios
echo "AVISO: socket de Docker sin grupo propio; se mantiene root" >&2
exec "$@"
