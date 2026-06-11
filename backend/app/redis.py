import asyncio

from arq import ArqRedis
from arq.connections import ConnectionPool
from app.config import config

def create_redis_connection():
    pool = ConnectionPool.from_url(config.REDIS_URL)
    return ArqRedis(pool)

async def close_redis_connection(redis: ArqRedis):
    await redis.close(close_connection_pool=True)

# Process-wide client backed by a single connection pool. redis-py asyncio
# clients are safe to share across concurrent tasks (each command checks out a
# connection from the pool), so request handlers reuse this instead of building
# and tearing down a fresh pool — and new TCP connections — on every request.
#
# A redis.asyncio client is bound to the event loop it was created on. In
# production that loop lives for the whole process, so the client is reused. The
# test suite (and any other case that runs requests on a fresh loop) creates a
# new loop per case, so we re-create the client whenever the running loop
# differs from the one the current client was bound to — otherwise reusing a
# client tied to a closed loop raises "Event loop is closed".
_shared_redis: ArqRedis | None = None
_shared_redis_loop: asyncio.AbstractEventLoop | None = None

def get_shared_redis() -> ArqRedis:
    global _shared_redis, _shared_redis_loop
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None
    if _shared_redis is None or _shared_redis_loop is not loop:
        _shared_redis = create_redis_connection()
        _shared_redis_loop = loop
    return _shared_redis

async def close_shared_redis() -> None:
    global _shared_redis, _shared_redis_loop
    client = _shared_redis
    client_loop = _shared_redis_loop
    _shared_redis = None
    _shared_redis_loop = None
    if client is None:
        return
    try:
        running = asyncio.get_running_loop()
    except RuntimeError:
        running = None
    # Only close on the loop the client was created on; closing a client bound
    # to a different (already-closed) loop raises "Event loop is closed". If the
    # loops differ, drop the reference and let it be garbage-collected.
    if client_loop is None or client_loop is running:
        try:
            await close_redis_connection(client)
        except Exception:
            pass

async def get_redis():
    yield get_shared_redis()
