from arq import ArqRedis
import asyncssh
import asyncio
import time
from typing import Optional, Any
from sqlalchemy.orm import Session

from app.models.log import new_log as log
from app.models.frame import Frame
from app.models.settings import Settings

# ---------------------------------------
# GLOBAL POOL STORAGE
# ---------------------------------------
_pool_lock = asyncio.Lock()

# Keys in this dict: (host, port, username, 'password' or 'key'), e.g. ("192.168.1.1", 22, "ubuntu", "password")
# Values: List of PooledConnection objects
_ssh_pool: dict[tuple[Any, Any | int, Any, str], list["PooledConnection"]] = {}

# If a connection is idle more than this many seconds, it will be closed.
IDLE_TIMEOUT_SECONDS = 30


class PooledConnection:
    """
    Holds one actual asyncssh connection plus usage metadata.
    """
    def __init__(self, ssh: asyncssh.SSHClientConnection):
        self.ssh = ssh
        self.in_use = False
        self.last_used = time.time()
        self.closing_task: Optional[asyncio.Task] = None

    def expired(self):
        return (time.time() - self.last_used) >= IDLE_TIMEOUT_SECONDS

    def mark_in_use(self):
        self.in_use = True
        self.last_used = time.time()
        # If there was a close scheduled, cancel it.
        if self.closing_task and not self.closing_task.done():
            self.closing_task.cancel()
        self.closing_task = None

    def mark_idle(self):
        self.in_use = False
        self.last_used = time.time()

    async def schedule_close(self, pool_key, db, redis, frame_id):
        """
        Waits for IDLE_TIMEOUT_SECONDS. If still idle afterward, close the SSH connection.
        """
        try:
            await asyncio.sleep(IDLE_TIMEOUT_SECONDS)
        except asyncio.CancelledError:
            # If the close was canceled, that means the connection was reused.
            return

        # Double-check: if still not in use, close it for real
        if not self.in_use and self.expired():
            # Actually close the underlying SSH connection
            self.ssh.close()
            await log(db, redis, frame_id, "stdinfo", f"SSH connection closed ({IDLE_TIMEOUT_SECONDS}s idle timeout)")
            try:
                await self.ssh.wait_closed()
            except asyncio.CancelledError:
                pass

            # Remove it from the global pool list
            async with _pool_lock:
                if pool_key in _ssh_pool:
                    if self in _ssh_pool[pool_key]:
                        _ssh_pool[pool_key].remove(self)


# ---------------------------------------
# PUBLIC SSH UTILS
# ---------------------------------------

async def get_ssh_connection(db: Session, redis: ArqRedis, frame: Frame) -> asyncssh.SSHClientConnection:
    """
    Retrieve an SSH connection from the pool if available. Otherwise, open a new one.
    If all existing connections for this frame's credentials are in use, create another one.
    """
    host = frame.frame_host
    port = frame.ssh_port or 22
    username = frame.ssh_user
    password = frame.ssh_pass

    # Build a pool key
    if password:
        auth_label = "password"
    else:
        auth_label = "key"

    pool_key = (host, port, username, auth_label)

    async with _pool_lock:
        # 1) Clean up any connections that have been closed or that had errors:
        to_remove = []
        if pool_key in _ssh_pool:
            for pc in _ssh_pool[pool_key]:
                if not pc.in_use and pc.expired():
                    to_remove.append(pc)
            for pc in to_remove:
                _ssh_pool[pool_key].remove(pc)

        # 2) Look for an idle connection
        if pool_key in _ssh_pool:
            for pc in _ssh_pool[pool_key]:
                if not pc.in_use:  # found an idle connection
                    pc.mark_in_use()
                    # await log(db, redis, frame.id, "stdinfo", "Reusing existing SSH connection")
                    return pc.ssh

        # No idle connections or no list at all -> create new one
        new_ssh = await _create_new_connection(db, redis, frame)
        pc = PooledConnection(new_ssh)
        pc.mark_in_use()

        _ssh_pool.setdefault(pool_key, []).append(pc)

        return new_ssh


async def remove_ssh_connection(db, redis, ssh: asyncssh.SSHClientConnection, frame: Frame):
    """
    Release the SSH connection back to the pool so it can be reused or closed after IDLE_TIMEOUT_SECONDS.
    """
    if not ssh:
        return

    # Find which pool entry this belongs to
    host = frame.frame_host
    port = frame.ssh_port or 22
    username = frame.ssh_user
    password = frame.ssh_pass
    auth_label = "password" if password else "key"
    pool_key = (host, port, username, auth_label)

    async with _pool_lock:
        # If we don't have this key at all, there's nothing to do
        if pool_key not in _ssh_pool:
            return

        # Look for the matching PooledConnection
        for pc in _ssh_pool[pool_key]:
            if pc.ssh is ssh:
                # await log(db, redis, frame.id, "stdinfo", "SSH connection scheduled for closure")
                pc.mark_idle()
                await schedule_close(pc, pool_key, db, redis, frame.id)
                return


async def schedule_close(pc: PooledConnection, pool_key, db, redis, frame_id):
    """
    Schedules a close task for the given PooledConnection.
    """
    # If there's already a scheduled close, don't duplicate.
    if pc.closing_task and not pc.closing_task.done():
        return

    pc.closing_task = asyncio.create_task(pc.schedule_close(pool_key, db, redis, frame_id))


# ---------------------------------------
# LOW-LEVEL / INTERNAL
# ---------------------------------------

async def _create_new_connection(db, redis, frame) -> asyncssh.SSHClientConnection:
    """Actually create a brand-new SSH connection."""
    host = frame.frame_host
    port = frame.ssh_port or 22
    username = frame.ssh_user
    password = frame.ssh_pass

    await log(
        db, redis, frame.id, "stdinfo",
        f"Connecting via SSH to {username}@{host} "
        f"({'password' if password else 'keypair'})"
    )

    # 1) If password is set, just do password-based auth
    # 2) Otherwise, load the private key from DB
    client_keys = []
    if not password:
        # Attempt to load SSH keys from DB
        ssh_keys_row = db.query(Settings).filter_by(key="ssh_keys").first()
        if ssh_keys_row and ssh_keys_row.value:
            default_key = ssh_keys_row.value.get("default", None)
            if default_key:
                # Convert string -> asyncssh private key object
                try:
                    # asyncssh can parse the key directly:
                    private_key_obj = asyncssh.import_private_key(default_key)
                except (asyncssh.KeyImportError, TypeError):
                    raise Exception("Could not parse the private key from DB. Check if it's valid PEM.")
                client_keys = [private_key_obj]
            else:
                raise Exception("No default key found in DB for SSH.")
        else:
            raise Exception("No password set and no SSH keys found in DB (ssh_keys).")

    try:
        ssh = await asyncssh.connect(
            host=host,
            port=port,
            username=username,
            password=password if password else None,
            client_keys=client_keys if not password else None,
            known_hosts=None
        )
        await log(db, redis, frame.id, "stdinfo", f"SSH connection established to {username}@{host}")
        return ssh
    except (OSError, asyncssh.Error) as exc:
        raise Exception(f"Unable to connect to {host}:{port} via SSH: {exc}")


async def exec_command(
    db: Session,
    redis: ArqRedis,
    frame: Frame,
    ssh: asyncssh.SSHClientConnection,
    command: str,
    output: Optional[list[str]] = None,
    log_output: bool = True,
    raise_on_error: bool = True
) -> int:
    """
    Execute a command on the remote host using an existing SSH connection.
    Stream stdout and stderr lines as they arrive, optionally storing them
    into 'output' and logging them in the database.
    Returns the process exit status.
    """
    await log(db, redis, frame.id, "stdout", f"> {command}")

    stdout_buffer: list[str] = []
    stderr_buffer: list[str] = []
    combined_buffer: list[str] = []

    try:
        process = await ssh.create_process(command)

        # parallel read
        stdout_task = asyncio.create_task(
            _stream_lines(db, redis, frame, process.stdout, "stdout", log_output, stdout_buffer, combined_buffer)
        )
        stderr_task = asyncio.create_task(
            _stream_lines(db, redis, frame, process.stderr, "stderr", log_output, stderr_buffer, combined_buffer)
        )

        await asyncio.gather(stdout_task, stderr_task)

        response = await process.wait()
        exit_status = response.exit_status or 0

        # Capture combined stdout if needed
        if output is not None:
            joined_output = "".join(combined_buffer)
            output.extend(joined_output.split("\n"))

        if exit_status != 0:
            stderr_data = "".join(stderr_buffer).strip()
            stdout_data = "".join(stdout_buffer).strip()
            if raise_on_error:
                raise Exception(
                    f"Command '{command}' failed with code {exit_status}\n"
                    f"stderr: {stderr_data}\n"
                    f"stdout: {stdout_data}"
                )
            else:
                await log(
                    db, redis, frame.id, "exit_status",
                    f"The command exited with status {exit_status}"
                )

        return exit_status

    except asyncssh.ProcessError as e:
        raise Exception(f"Error running command '{command}': {e}") from e


async def _stream_lines(
    db: Session,
    redis: ArqRedis,
    frame: Frame,
    stream,
    log_type: str,
    log_output: bool,
    buffer_list: Optional[list[str]],
    combined_buffer_list: Optional[list[str]]
):
    """
    Helper to read lines from `stream` (stdout or stderr) and:
    - Optionally log each line
    - Optionally store each line in buffer_list
    """
    while True:
        raw = await stream.readline()
        if not raw:                       # EOF
            break
        line = raw.decode("utf-8", errors="replace") if isinstance(raw, bytes) else str(raw)
        if not line:
            break
        if buffer_list is not None:
            buffer_list.append(line)
        if combined_buffer_list is not None:
            combined_buffer_list.append(line)
        if log_output:
            await log(db, redis, frame.id, log_type, line.rstrip('\n'))
