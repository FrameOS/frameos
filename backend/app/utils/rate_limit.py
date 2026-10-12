"""Small Redis counters shared by the login, cloud-login and device-log paths.

Every key is namespaced per test instance so parallel test runs against one
Redis do not lock each other out.
"""
from arq import ArqRedis as Redis

from app import config as app_config


def rate_limit_key(name: str, subject: str) -> str:
    key = f"ratelimit:{name}:{subject}"
    if app_config.config.TEST:
        key += f":{app_config.config.INSTANCE_ID}"
    return key


async def hit_rate_limit(redis: Redis, name: str, subject: str, *, limit: int, window_seconds: int) -> bool:
    """Count one hit for `subject` and report whether it is now over `limit`
    within a fixed window of `window_seconds`.

    The window is set on any counter without one, not only on the first hit.
    INCR and EXPIRE are two commands: a request that dies between them (the
    dev server's --reload, a cancelled task, a dropped Redis connection)
    leaves a counter that never resets, and a frame whose log counter did
    that answered 429 to every log batch until Redis was flushed — the frame
    looked dead while it rendered fine."""
    key = rate_limit_key(name, subject)
    async with redis.pipeline(transaction=True) as pipe:
        pipe.incr(key)
        pipe.ttl(key)
        count, ttl = await pipe.execute()
    if int(ttl) < 0:
        await redis.expire(key, window_seconds)
    return int(count) > limit


async def over_rate_limit(redis: Redis, name: str, subject: str, *, limit: int) -> bool:
    """Whether `subject` has already used up `limit` hits, without counting one."""
    count = await redis.get(rate_limit_key(name, subject))
    return int(count or 0) >= limit


async def clear_rate_limit(redis: Redis, name: str, subject: str) -> None:
    await redis.delete(rate_limit_key(name, subject))
