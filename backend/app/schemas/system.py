from pydantic import BaseModel


class DiskInfo(BaseModel):
    totalBytes: int
    usedBytes: int
    freeBytes: int


class MemoryInfo(BaseModel):
    totalBytes: int | None
    availableBytes: int | None


class LoadInfo(BaseModel):
    one: float | None
    five: float | None
    fifteen: float | None


class CacheInfo(BaseModel):
    name: str
    path: str
    sizeBytes: int
    exists: bool


class DatabaseInfo(BaseModel):
    path: str | None
    sizeBytes: int | None
    exists: bool


class SystemInfoResponse(BaseModel):
    disk: DiskInfo
    caches: list[CacheInfo]
    database: DatabaseInfo
    memory: MemoryInfo
    load: LoadInfo


class SystemMetricsResponse(BaseModel):
    disk: DiskInfo
    memory: MemoryInfo
    load: LoadInfo
