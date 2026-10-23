# DockPilot

Panel web autohospedado para gestionar contenedores Docker locales y remotos desde una sola interfaz.

![Python](https://img.shields.io/badge/Python-3.11-3776AB?logo=python&logoColor=white)
![FastAPI](https://img.shields.io/badge/FastAPI-0.115-009688?logo=fastapi&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white)
![Licencia](https://img.shields.io/badge/licencia-MIT-green)

DockPilot reúne en un único panel el estado de los contenedores del host y de
varios servidores remotos por SSH: métricas del sistema, logs, operaciones
básicas y acciones de mantenimiento. Todo corre en un contenedor, sin base de
datos ni servicios externos.

## Características

- **Contenedores**: listar, iniciar, detener, reiniciar, ver logs y eliminar,
  con confirmación y borrado seguro (imagen y volúmenes son opcionales).
- **Múltiples servidores**: cada servidor SSH se abre como una pestaña propia,
  con sus propios contenedores y métricas.
- **Métricas en vivo**: CPU, RAM, disco y temperatura, con auto-refresco.
- **Mantenimiento remoto**: actualización de paquetes (`apt`) con salida en vivo
  y reinicio del servidor.
- **Autenticación**: usuario único con contraseña cifrada (bcrypt) y sesión
  firmada; cambio de credenciales desde el panel.
- **Seguridad por defecto**: credenciales SSH cifradas en el servidor, host keys
  con TOFU, validación estricta de entradas y contenedor sin privilegios.

## Arquitectura

| Capa | Tecnología |
|---|---|
| Backend | FastAPI + Uvicorn |
| Frontend | HTML, CSS y JavaScript sin paso de compilación |
| Docker | Docker SDK (`docker.from_env`) |
| SSH | Paramiko |
| Métricas | psutil |

```
Navegador ──HTTP(S)──> DockPilot (FastAPI)
                          ├── /var/run/docker.sock ──> contenedores locales
                          └── SSH ───────────────────> servidores remotos
```

## Inicio rápido

Requisitos: Docker Engine 20.10+ y Docker Compose v2.

```bash
git clone https://github.com/JUANRESTREPO95/dockpilot.git
cd dockpilot
cp .env.example .env      # ajusta HOST_IP si hace falta
docker compose up -d --build
```

Abre `http://localhost:8000`.

En el primer arranque se crea el usuario **`admin`** con contraseña **`123`**.
Cámbiala inmediatamente desde el botón de cuenta (arriba a la derecha); el panel
muestra un aviso mientras siga siendo la contraseña por defecto.

## Configuración

Todas las variables son opcionales y se leen desde `.env`:

| Variable | Por defecto | Descripción |
|---|---|---|
| `HOST_IP` | autodetectada | IP del host usada en los enlaces a puertos publicados |
| `BIND_ADDR` | `0.0.0.0` | Interfaz donde se publica el panel |
| `TRUSTED_PROXIES` | vacío | IP del proxy inverso para confiar en `X-Forwarded-*` |

## Datos persistentes

Todo se guarda en el volumen `dockpilot-data` montado en `/data`:

| Archivo | Contenido |
|---|---|
| `users.json` | Usuario y hash bcrypt de la contraseña |
| `session.key` | Secreto de firma de las sesiones |
| `servers.json` | Servidores SSH con la contraseña cifrada (Fernet) |
| `servers.key` | Clave de cifrado de las contraseñas SSH |
| `known_hosts` | Huellas de los servidores SSH (TOFU) |

Si se borra el volumen, el panel vuelve a `admin` / `123` y se pierden los
servidores configurados.

## Seguridad

DockPilot monta el socket de Docker, lo que equivale a privilegios de root sobre
el host. Por eso:

- No lo expongas a Internet sin HTTPS y una contraseña fuerte.
- Detrás de un proxy inverso, publica el panel en `127.0.0.1` (`BIND_ADDR=127.0.0.1`)
  y define `TRUSTED_PROXIES` con la IP del proxy.
- Las contraseñas SSH nunca llegan al navegador: el cliente solo envía un
  identificador de servidor.
- Los comandos remotos usan una lista cerrada de acciones; no hay ejecución de
  comandos arbitrarios.
- El contenedor corre como usuario sin privilegios, con `cap_drop: ALL`,
  sistema de archivos de solo lectura y límites de recursos.
- Cada escritura queda registrada en el log: `AUDIT usuario MÉTODO ruta -> código`.

## Estructura del proyecto

```
.
├── backend/
│   ├── auth.py              sesiones, contraseñas y rate limit
│   ├── main.py              aplicación FastAPI, rutas y cabeceras
│   ├── entrypoint.sh        permisos y arranque sin privilegios
│   ├── Dockerfile
│   ├── requirements.txt
│   ├── routers/
│   │   ├── auth_routes.py   login, logout y credenciales
│   │   ├── containers.py    contenedores locales
│   │   ├── ssh.py           contenedores y métricas remotas
│   │   ├── ssh_servers.py   almacenamiento cifrado de servidores
│   │   ├── ssh_servers_routes.py
│   │   ├── server_ops.py    actualizar y reiniciar
│   │   └── metrics.py       métricas locales
│   └── static/              interfaz (HTML, CSS, JS)
├── docker-compose.yml
├── .env.example
└── LICENSE
```

## API

Todos los endpoints salvo `/auth/login` y los archivos estáticos requieren una
sesión válida.

| Método | Ruta | Descripción |
|---|---|---|
| `POST` | `/auth/login` | Iniciar sesión |
| `POST` | `/auth/logout` | Cerrar sesión |
| `GET` | `/auth/me` | Sesión actual |
| `POST` | `/auth/credentials` | Cambiar usuario o contraseña |
| `GET` | `/containers/` | Listar contenedores locales |
| `POST` | `/containers/{id}/start\|stop\|restart` | Acciones sobre un contenedor |
| `GET` | `/containers/{id}/logs` | Últimas 100 líneas de log |
| `DELETE` | `/containers/{id}/remove` | Eliminar (flags `remove_image`, `remove_volumes`) |
| `GET` | `/metrics/local` | Métricas del host local |
| `GET` | `/ssh/servers/` | Listar servidores SSH |
| `POST` | `/ssh/servers/` | Añadir servidor SSH |
| `DELETE` | `/ssh/servers/{id}` | Eliminar servidor SSH |
| `POST` | `/ssh/containers` | Listar contenedores remotos |
| `POST` | `/ssh/containers/{action}` | Acciones sobre un contenedor remoto |
| `POST` | `/ssh/containers/logs` | Logs remotos |
| `POST` | `/ssh/metrics` | Métricas remotas |
| `POST` | `/servers/{id}/update` | Actualizar paquetes con `apt` |
| `GET` | `/servers/{id}/update` | Estado y salida de la actualización |
| `POST` | `/servers/{id}/reboot` | Reiniciar el servidor |

## Desarrollo

El backend necesita acceso al socket de Docker. Para trabajar sin reconstruir la
imagen:

```bash
docker compose up -d --build
docker compose logs -f dockpilot
```

Los cambios en `backend/static/` se aplican recargando el navegador; los cambios
en Python requieren `docker compose up -d --build`.

## Licencia

[MIT](LICENSE)
