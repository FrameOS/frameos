from arq import ArqRedis
from arq.connections import ConnectionPool
from app.config import config

def create_redis_connection():
    pool = ConnectionPool.from_url(config.REDIS_URL)
    return ArqRedis(pool)

async def get_redis():
    redis = create_redis_connection()
    try:
        yield redis
    finally:
        await redis.close()
