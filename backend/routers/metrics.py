import psutil
import os
from fastapi import APIRouter

router = APIRouter()

def get_temperature():
    try:
        temps = psutil.sensors_temperatures()
        if not temps:
            return None
        # Buscar en orden de prioridad
        for key in ["coretemp", "k10temp", "cpu_thermal", "acpitz"]:
            if key in temps and temps[key]:
                return round(temps[key][0].current, 1)
        # Tomar el primero disponible
        for key, entries in temps.items():
            if entries:
                return round(entries[0].current, 1)
    except Exception:
        pass
    return None

@router.get("/local")
def get_local_metrics():
    cpu = psutil.cpu_percent(interval=0.1)
    ram = psutil.virtual_memory()
    disk = psutil.disk_usage("/")
    temp = get_temperature()

    return {
        "cpu": round(cpu, 1),
        "ram": {
            "total_gb": round(ram.total / 1e9, 1),
            "used_gb":  round(ram.used  / 1e9, 1),
            "percent":  ram.percent,
        },
        "disk": {
            "total_gb": round(disk.total / 1e9, 1),
            "used_gb":  round(disk.used  / 1e9, 1),
            "percent":  round(disk.percent, 1),
        },
        "temperature": temp,
    }
