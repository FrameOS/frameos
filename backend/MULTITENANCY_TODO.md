# Multitenancy Todo

This file tracks the cloud-ready multitenancy work in progress.

- [x] Define the target tenant model: organizations own projects; users join organizations.
- [x] Add organization/project models and default project bootstrap helpers.
- [x] Add `project_id` columns to tenant-owned models.
- [x] Add Alembic migration to backfill existing data into one default project.
- [x] Move project-owned API endpoints under `/api/projects/{project_id}`.
- [x] Scope every project-owned database read/write by the selected project.
- [x] Scope terminal WebSockets under `/ws/projects/{project_id}/terminal/{frame_id}`.
- [x] Generate project-scoped bootstrap and SD image download URLs.
- [x] Enforce globally unique frame `server_api_key` values for frame-originated ingress.
- [x] Add frontend project URL rewriting for project-owned API, image, download, and WebSocket paths.
- [x] Add access-control tests that prove cross-project reads and writes are denied.
- [x] Update tests and fixtures for project-scoped URLs and required tenant ids.
- [x] Remove hidden non-project aliases for project-owned template and scene-image writes.
- [x] Make DB-backed settings reads require a project id.
- [x] Scope worker deploy/build settings reads by frame project.
- [x] Keep backend PostHog clients isolated by project.
- [x] Bound lazy per-project PostHog memory with an LRU cache.
- [x] Run focused backend/frontend checks and address regressions.

Verified:
- `pnpm --dir frontend exec tsc --noEmit`
- `python -m compileall -q backend/app`
- `TEST=1 DATABASE_URL=sqlite:////private/tmp/frameos-mt-alembic-final-unique.db python -m alembic upgrade head`
- `env TEST=1 DATABASE_URL=sqlite:////private/tmp/frameos-test-frames-redis-escalated.db REDIS_URL=redis://127.0.0.1:6379/1 pytest app/api/tests/test_frames.py -q`
- `env TEST=1 DATABASE_URL=sqlite:////private/tmp/frameos-test-api-group.db REDIS_URL=redis://127.0.0.1:6379/1 pytest app/api/tests/test_settings.py app/api/tests/test_templates.py app/api/tests/test_repositories.py app/api/tests/test_frame_uploads.py app/api/tests/test_deploy_plan.py app/api/tests/test_apps.py app/api/tests/test_log.py app/api/tests/test_multitenancy.py -q`
- `env TEST=1 DATABASE_URL=sqlite:////private/tmp/frameos-test-auth-users.db REDIS_URL=redis://127.0.0.1:6379/1 pytest app/api/tests/test_auth.py app/api/tests/test_users.py -q`
- `env TEST=1 DATABASE_URL=sqlite:////private/tmp/frameos-test-model-ws.db REDIS_URL=redis://127.0.0.1:6379/1 pytest app/models/tests/test_settings.py app/models/tests/test_frame.py app/models/tests/test_log.py app/models/tests/test_metrics.py app/ws/tests/test_websockets.py -q`
- `env TEST=1 DATABASE_URL=sqlite:////private/tmp/frameos-mt-api-rerun-2.db REDIS_URL=redis://127.0.0.1:6379/1 pytest app/api/tests/test_templates.py app/api/tests/test_multitenancy.py app/api/tests/test_frames.py app/api/tests/test_log.py app/api/tests/test_settings.py -q`
- `env TEST=1 DATABASE_URL=sqlite:////private/tmp/frameos-mt-models-rerun-2.db REDIS_URL=redis://127.0.0.1:6379/1 pytest app/models/tests/test_settings.py app/models/tests/test_template.py app/models/tests/test_repository.py app/models/tests/test_metrics.py app/models/tests/test_log.py app/models/tests/test_frame.py app/utils/tests/test_build_host.py app/utils/tests/test_posthog.py app/tasks/tests/test_task_frame_refresh.py -q`
- `env TEST=1 DATABASE_URL=sqlite:////private/tmp/frameos-posthog-lru.db pytest app/utils/tests/test_posthog.py app/models/tests/test_settings.py -q`
- `env TEST=1 DATABASE_URL=sqlite:////private/tmp/frameos-posthog-lru-api.db pytest app/api/tests/test_settings.py app/api/tests/test_multitenancy.py -q`

The pytest commands used isolated SQLite database files and a local Redis container.

Notes:
- Global/system routes stay outside project scope: auth, current user, system info, bundled app catalog, system repository assets, and frame webhook auth by per-frame `server_api_key`.
- Tenant-owned resources: frames, settings, uploaded assets/fonts, user repositories, templates, chats/messages, AI embeddings, logs, metrics, and scene images.
- Login and signup both ensure the single default project exists for the current user until configurable user/project selection is added.
