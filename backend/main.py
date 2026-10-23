import logging
import os
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from auth import COOKIE_NAME, ensure_default_user, require_auth, verify_token
from routers import auth_routes, containers, metrics, server_ops, ssh, ssh_servers_routes

audit = logging.getLogger("dockpilot.audit")
audit.setLevel(logging.INFO)
if not audit.handlers:
    _handler = logging.StreamHandler()
    _handler.setFormatter(logging.Formatter("%(asctime)s AUDIT %(message)s"))
    audit.addHandler(_handler)
    audit.propagate = False

CSP = (
    "default-src 'self'; "
    "script-src 'self' 'unsafe-inline'; "
    "style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data:; "
    "font-src 'self'; "
    "connect-src 'self'; "
    "frame-ancestors 'none'; "
    "base-uri 'none'; "
    "form-action 'self'"
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Crea admin/123 la primera vez. Con volumen en /data persiste.
    ensure_default_user()
    yield


app = FastAPI(title="DockPilot API", lifespan=lifespan)

# Cabeceras de proxy (X-Forwarded-*) solo si hay un proxy de confianza.
# Ej: TRUSTED_PROXIES=172.18.0.2 (la IP del contenedor de Nginx Proxy Manager).
trusted_proxies = [p.strip() for p in os.environ.get("TRUSTED_PROXIES", "").split(",") if p.strip()]
if trusted_proxies:
    from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware
    app.add_middleware(ProxyHeadersMiddleware, trusted_hosts=trusted_proxies)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Content-Security-Policy"] = CSP
    response.headers["Permissions-Policy"] = "geolocation=(), microphone=(), camera=()"
    if request.url.scheme == "https":
        response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    return response


@app.middleware("http")
async def audit_actions(request: Request, call_next):
    response = await call_next(request)
    if request.method in ("POST", "PUT", "PATCH", "DELETE"):
        user = verify_token(request.cookies.get(COOKIE_NAME)) or "-"
        audit.info("%s %s %s -> %s", user, request.method, request.url.path, response.status_code)
    return response


# Auth (login/logout/me/credentials)
app.include_router(auth_routes.router, prefix="/auth", tags=["Auth"])

# API routes (todas protegidas por sesión)
app.include_router(
    containers.router, prefix="/containers", tags=["Containers"],
    dependencies=[Depends(require_auth)],
)
app.include_router(
    ssh.router, prefix="/ssh", tags=["SSH"],
    dependencies=[Depends(require_auth)],
)
app.include_router(
    ssh_servers_routes.router, prefix="/ssh/servers", tags=["SSH Servers"],
    dependencies=[Depends(require_auth)],
)
app.include_router(
    server_ops.router, prefix="/servers", tags=["Server Ops"],
    dependencies=[Depends(require_auth)],
)
app.include_router(
    metrics.router, prefix="/metrics", tags=["Metrics"],
    dependencies=[Depends(require_auth)],
)

# Serve frontend static files
static_dir = os.path.join(os.path.dirname(__file__), "static")
app.mount("/static", StaticFiles(directory=static_dir), name="static")


@app.get("/")
def root():
    return FileResponse(os.path.join(static_dir, "index.html"))


@app.get("/host-ip", dependencies=[Depends(require_auth)])
def get_host_ip():
    return {"host_ip": os.environ.get("HOST_IP", "127.0.0.1")}
