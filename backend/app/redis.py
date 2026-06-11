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
_shared_redis: ArqRedis | None = None

def get_shared_redis() -> ArqRedis:
    global _shared_redis
    if _shared_redis is None:
        _shared_redis = create_redis_connection()
    return _shared_redis

async def close_shared_redis() -> None:
    global _shared_redis
    if _shared_redis is not None:
        await close_redis_connection(_shared_redis)
        _shared_redis = None

async def get_redis():
    yield get_shared_redis()
