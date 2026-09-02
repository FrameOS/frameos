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
    within a fixed window of `window_seconds`."""
    key = rate_limit_key(name, subject)
    count = await redis.incr(key)
    if count == 1:
        await redis.expire(key, window_seconds)
    return int(count) > limit


async def over_rate_limit(redis: Redis, name: str, subject: str, *, limit: int) -> bool:
    """Whether `subject` has already used up `limit` hits, without counting one."""
    count = await redis.get(rate_limit_key(name, subject))
    return int(count or 0) >= limit


async def clear_rate_limit(redis: Redis, name: str, subject: str) -> None:
    await redis.delete(rate_limit_key(name, subject))
