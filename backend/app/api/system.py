from app.api import api_with_auth
from app.schemas.system import CacheInfo, DatabaseInfo, DiskInfo, LoadInfo, MemoryInfo, SystemInfoResponse, SystemMetricsResponse
from app.utils.system_info import get_system_info, get_system_metrics


def _disk_to_schema(disk) -> DiskInfo:
    return DiskInfo(totalBytes=disk.total_bytes, usedBytes=disk.used_bytes, freeBytes=disk.free_bytes)


def _memory_to_schema(memory) -> MemoryInfo:
    return MemoryInfo(totalBytes=memory.total_bytes, availableBytes=memory.available_bytes)


def _load_to_schema(load) -> LoadInfo:
    return LoadInfo(one=load.one, five=load.five, fifteen=load.fifteen)


def _cache_to_schema(caches) -> list[CacheInfo]:
    return [CacheInfo(name=cache.name, path=str(cache.path), sizeBytes=cache.size_bytes, exists=cache.exists) for cache in caches]


def _database_to_schema(database) -> DatabaseInfo:
    return DatabaseInfo(
        path=str(database.path) if database.path else None,
        sizeBytes=database.size_bytes,
        exists=database.exists,
    )


@api_with_auth.get("/system/info", response_model=SystemInfoResponse)
def system_info():
    disk, caches, database, memory, load = get_system_info()
    return SystemInfoResponse(
        disk=_disk_to_schema(disk),
        caches=_cache_to_schema(caches),
        database=_database_to_schema(database),
        memory=_memory_to_schema(memory),
        load=_load_to_schema(load),
    )


@api_with_auth.get("/system/metrics", response_model=SystemMetricsResponse)
def system_metrics():
    disk, memory, load = get_system_metrics()
    return SystemMetricsResponse(
        disk=_disk_to_schema(disk),
        memory=_memory_to_schema(memory),
        load=_load_to_schema(load),
    )
