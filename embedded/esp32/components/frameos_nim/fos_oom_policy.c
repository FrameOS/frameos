#include "fos_oom_policy.h"

void fos_oom_policy_healthy(fos_oom_policy_t *policy, size_t free_now)
{
    policy->streak = 0;
    if (policy->baseline == 0) policy->baseline = free_now;
}

bool fos_oom_policy_abort(fos_oom_policy_t *policy, size_t free_before, size_t free_after,
                          size_t largest, size_t canvas_bytes)
{
    policy->streak++;
    if (free_before > free_after) policy->leaked += free_before - free_after;
    bool canvas_impossible = canvas_bytes > 0 && largest < canvas_bytes;
    bool leaked_too_much = policy->baseline > 0 &&
        policy->leaked > policy->baseline / 100u * FOS_OOM_LEAK_RESTART_PERCENT;
    return (policy->streak >= 2 && canvas_impossible) ||
           policy->streak >= FOS_OOM_RESTART_STREAK ||
           leaked_too_much;
}
