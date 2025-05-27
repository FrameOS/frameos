from datetime import datetime
import json
import os
import random
import shutil
import string
import tempfile
from typing import Any, Optional

import asyncssh

from arq import ArqRedis as Redis
from sqlalchemy.orm import Session

from app.models.log import new_log as log
from app.models.frame import Frame, get_frame_json
from app.utils.ssh_utils import get_ssh_connection, exec_command, remove_ssh_connection, exec_local_command
from .utils import find_nim_v2, find_nimbase_file

async def redeploy_agent(id: int, redis: Redis):
    await redis.enqueue_job("redeploy_agent", id=id)

class AgentDeployer:
    ## This entire file is a big refactor in progress.
    def __init__(self, db: Session, redis: Redis, frame: Frame, nim_path: str, temp_dir: str, ssh: asyncssh.SSHClientConnection):
        self.db = db
        self.redis = redis
        self.frame = frame
        self.nim_path = nim_path
        self.temp_dir = temp_dir
        self.ssh = ssh
        self.build_id = ''.join(random.choice(string.ascii_lowercase) for _ in range(12))

    def has_agent_connection(self) -> bool:
        return self.frame.network and self.frame.network.get('agentConnection', False) and len(str(self.frame.network.get('agentSharedSecret', ''))) > 0

    async def exec_command(
        self,
        command: str,
        output: Optional[list[str]] = None,
        log_output: bool = True,
        raise_on_error: bool = True
    ) -> int:
        return await exec_command(
            self.db, self.redis, self.frame, self.ssh,
            command, output=output, log_output=log_output, raise_on_error=raise_on_error
        )

    async def log(self, type: str, line: str, timestamp: Optional[datetime] = None):
        await log(self.db, self.redis, int(self.frame.id), type=type, line=line, timestamp=timestamp)


async def redeploy_agent_task(ctx: dict[str, Any], id: int):
    db: Session = ctx['db']
    redis: Redis = ctx['redis']

    ssh = None
    frame = db.get(Frame, id)
    if not frame:
        raise Exception("Frame not found")

    try:
        nim_path = find_nim_v2()
        ssh = await get_ssh_connection(db, redis, frame)

        with tempfile.TemporaryDirectory() as temp_dir:
            self = AgentDeployer(db=db, redis=redis, frame=frame, nim_path=nim_path, temp_dir=temp_dir, ssh=ssh)
            build_id = self.build_id
            await self.log("stdout", f"Deploying agent {frame.name} with build id {self.build_id}")

            await self.log("stdout", "- Getting target architecture")
            uname_output: list[str] = []
            await self.exec_command("uname -m", uname_output)
            arch = "".join(uname_output).strip()
            if arch in ("aarch64", "arm64"):
                cpu = "arm64"
            elif arch in ("armv6l", "armv7l"):
                cpu = "arm"
            elif arch == "i386":
                cpu = "i386"
            else:
                cpu = "amd64"

            if self.has_agent_connection():
                await self.log("stdout", "- Deploying agent")
                await deploy_agent(self, cpu)
                await setup_agent_service(self)
                await self.exec_command("sudo systemctl enable frameos_agent.service")
                await self.exec_command("sudo systemctl restart frameos_agent.service")
                await self.exec_command("sudo systemctl status frameos_agent.service")
            else:
                await self.exec_command("sudo systemctl disable frameos_agent.service", raise_on_error=False)
                await self.exec_command("sudo systemctl stop frameos_agent.service", raise_on_error=False)

            # 4. Upload frame.json using a TEMP FILE approach
            frame_json_data = (json.dumps(get_frame_json(db, frame), indent=4) + "\n").encode('utf-8')
            with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as tmpf:
                local_json_path = tmpf.name
                tmpf.write(frame_json_data)
            await asyncssh.scp(
                local_json_path, (ssh, f"/srv/frameos/agent/releases/release_{build_id}/frame.json"),
                recurse=False
            )
            os.remove(local_json_path)  # remove local temp file
            await self.log("stdout", f"> add /srv/frameos/agent/releases/release_{build_id}/frame.json")

            # 6. Link new release
            await self.exec_command(
                f"rm -rf /srv/frameos/agent/current && "
                f"ln -s /srv/frameos/agent/releases/release_{build_id} /srv/frameos/agent/current"
            )

            # Clean old builds
            await self.exec_command("cd /srv/frameos/agent/build && ls -dt1 agent_* | tail -n +11 | xargs rm -rf")
            await self.exec_command(
                "cd /srv/frameos/agent/releases && "
                "ls -dt1 release_* | grep -v \"$(basename $(readlink ../current))\" "
                "| tail -n +11 | xargs rm -rf"
            )


    except Exception as e:
        await self.log("stderr", str(e))
    finally:
        if ssh is not None:
            await remove_ssh_connection(db, redis, ssh, frame)


def create_agent_build_folders(self: AgentDeployer):
    build_dir = os.path.join(self.temp_dir, f"agent_{self.build_id}")
    source_dir = os.path.join(self.temp_dir, "agent")
    os.makedirs(source_dir, exist_ok=True)
    shutil.copytree("../agent", source_dir, dirs_exist_ok=True)
    os.makedirs(build_dir, exist_ok=True)
    return build_dir, source_dir

async def create_agent_local_build_archive(
    self: AgentDeployer,
    build_dir: str,
    source_dir: str,
    cpu: str
):
    debug_options = "--lineTrace:on" if self.frame.debug else ""
    cmd = (
        f"cd {source_dir} && nimble setup && "
        f"{self.nim_path} compile --os:linux --cpu:{cpu} "
        f"--compileOnly --genScript --nimcache:{build_dir} "
        f"{debug_options} src/frameos_agent.nim 2>&1"
    )

    status, out, err = await exec_local_command(self.db, self.redis, self.frame, cmd)
    if status != 0:
        raise Exception("Failed to generate agent sources")

    nimbase_path = find_nimbase_file(self.nim_path)
    if not nimbase_path:
        raise Exception("nimbase.h not found")

    shutil.copy(nimbase_path, os.path.join(build_dir, "nimbase.h"))

    archive_path = os.path.join(self.temp_dir, f"agent_{self.build_id}.tar.gz")
    zip_base = os.path.join(self.temp_dir, f"agent_{self.build_id}")
    shutil.make_archive(zip_base, 'gztar', self.temp_dir, f"agent_{self.build_id}")
    return archive_path


async def deploy_agent(self: AgentDeployer, cpu: str):
    # 1 Build the agent
    agent_build_dir, agent_source_dir = create_agent_build_folders(self)
    agent_archive_path = await create_agent_local_build_archive(self, agent_build_dir, agent_source_dir, cpu)

    await self.exec_command("mkdir -p /srv/frameos/agent/build/ /srv/frameos/agent/logs/ /srv/frameos/agent/releases/")

    # 2 Upload the local tarball
    await asyncssh.scp(
        agent_archive_path,
        (self.ssh, f"/srv/frameos/agent/build/agent_{self.build_id}.tar.gz"),
        recurse=False
    )
    # 3 Unpack & compile on device
    await exec_command(self.db, self.redis, self.frame, self.ssh,
                        f"cd /srv/frameos/agent/build && tar -xzf agent_{self.build_id}.tar.gz && rm agent_{self.build_id}.tar.gz")
    await exec_command(self.db, self.redis, self.frame, self.ssh,
                        f"cd /srv/frameos/agent/build/agent_{self.build_id} && sh compile_frameos_agent.sh")
    await exec_command(self.db, self.redis, self.frame, self.ssh, f"mkdir -p /srv/frameos/agent/releases/release_{self.build_id}")
    await exec_command(self.db, self.redis, self.frame, self.ssh,
                        f"cp /srv/frameos/agent/build/agent_{self.build_id}/frameos_agent "
                        f"/srv/frameos/agent/releases/release_{self.build_id}/frameos_agent")

async def setup_agent_service(self: AgentDeployer):
    # 5b. Upload frameos_agent.service with a TEMP FILE approach
    with open("../agent/frameos_agent.service", "r") as f:
        service_contents = f.read().replace("%I", self.frame.ssh_user)
    service_data = service_contents.encode('utf-8')
    with tempfile.NamedTemporaryFile(suffix=".service", delete=False) as tmpservice:
        local_service_path = tmpservice.name
        tmpservice.write(service_data)
    await asyncssh.scp(
        local_service_path,
        (self.ssh, f"/srv/frameos/agent/releases/release_{self.build_id}/frameos_agent.service"),
        recurse=False
    )
    os.remove(local_service_path)
    await exec_command(self.db, self.redis, self.frame, self.ssh,
                        f"sudo cp /srv/frameos/agent/releases/release_{self.build_id}/frameos_agent.service "
                        f"/etc/systemd/system/frameos_agent.service")
    await exec_command(self.db, self.redis, self.frame, self.ssh, "sudo chown root:root /etc/systemd/system/frameos_agent.service")
    await exec_command(self.db, self.redis, self.frame, self.ssh, "sudo chmod 644 /etc/systemd/system/frameos_agent.service")
