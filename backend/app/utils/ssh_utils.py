from arq import ArqRedis
import asyncssh
import asyncio
import hashlib
import time
from typing import Optional, Any
from sqlalchemy.orm import Session

from app.models.log import new_log as log
from app.models.frame import Frame, update_frame
from app.utils.ssh_host_keys import (
    host_key_changed_message,
    host_key_fingerprint,
    host_key_type,
    openssh_host_key_line,
    trusted_known_hosts,
)
from app.models.settings import Settings
from app.utils.ssh_key_utils import select_ssh_keys_for_frame

# ---------------------------------------
# GLOBAL POOL STORAGE
# ---------------------------------------
_pool_lock = asyncio.Lock()

# Keyed by `_pool_key`: the frame row and the credentials it would connect
# with. Never by address alone: a connection is an authenticated session, and
# a second frame row pointed at the same host, port and user (another
# project's, with credentials of its own or none that work) must open its
# own or fail to.
PoolKey = tuple[Any, Any, Any, Any, Any, str]
_ssh_pool: dict[PoolKey, list["PooledConnection"]] = {}

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
            await log(db, redis, frame_id, "stdinfo", f"SSH connection idle for {IDLE_TIMEOUT_SECONDS}s, closing until further commands")
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

def _frame_private_keys(db, frame) -> tuple[list[str], str]:
    """The private keys a key-authenticated connect to this frame offers, and
    their names for the log line."""
    ssh_keys_row = db.query(Settings).filter_by(project_id=frame.project_id, key="ssh_keys").first()
    settings = {"ssh_keys": ssh_keys_row.value} if ssh_keys_row and ssh_keys_row.value else {}
    selected_keys = select_ssh_keys_for_frame(frame, settings)
    keypair_names = [key.get("name") or key.get("id") for key in selected_keys]
    keypair_label = ", ".join([name for name in keypair_names if name]) or "unknown"
    return [str(key["private"]) for key in selected_keys if key.get("private")], keypair_label


def _pool_key(db, frame) -> PoolKey:
    """Who may share a pooled connection: the same frame row, at the same
    address, with the same credentials. The fingerprint covers what the
    connect would present, so changing a frame's password or keys stops it
    reusing a session opened with the old ones."""
    password = frame.ssh_pass
    if password:
        material = "password\0" + str(password)
    else:
        try:
            private_keys, _ = _frame_private_keys(db, frame)
        except Exception:
            private_keys = []
        material = "key\0" + "\0".join(str(key) for key in private_keys)
    fingerprint = hashlib.sha256(material.encode("utf-8", "replace")).hexdigest()
    return (
        getattr(frame, "project_id", None),
        getattr(frame, "id", None),
        frame.frame_host,
        frame.ssh_port or 22,
        frame.ssh_user,
        fingerprint,
    )


def _connection_matches_pin(ssh: asyncssh.SSHClientConnection, stored_host_key: str | None) -> bool:
    """Whether an open connection is to the host this frame is pinned to. A
    frame with no key recorded (never connected, or "Forget host key") reuses
    nothing: its next connect is the one that records the key."""
    stored = (stored_host_key or "").split()
    if len(stored) < 2:
        return False
    try:
        key = ssh.get_server_host_key()
    except Exception:
        return False
    if key is None:
        return False
    return openssh_host_key_line(key).split()[:2] == stored[:2]


async def get_ssh_connection(db: Session, redis: ArqRedis, frame: Frame) -> asyncssh.SSHClientConnection:
    """
    Retrieve an SSH connection from the pool if available. Otherwise, open a new one.
    If all existing connections for this frame's credentials are in use, create another one.
    """
    pool_key = _pool_key(db, frame)
    stored_host_key = getattr(frame, "ssh_host_key", None) or None

    async with _pool_lock:
        # 1) Clean up any connections that have been closed or that had errors:
        to_remove = []
        if pool_key in _ssh_pool:
            for pc in _ssh_pool[pool_key]:
                if not pc.in_use and pc.expired():
                    to_remove.append(pc)
            for pc in to_remove:
                _ssh_pool[pool_key].remove(pc)

        # 2) Look for an idle connection to the host this frame is pinned to
        if pool_key in _ssh_pool:
            for pc in _ssh_pool[pool_key]:
                if not pc.in_use and _connection_matches_pin(pc.ssh, stored_host_key):
                    pc.mark_in_use()
                    # await log(db, redis, frame.id, "stdinfo", "Reusing existing SSH connection")
                    return pc.ssh

    # No idle connection available. Establish the new connection WITHOUT holding
    # the global pool lock: _create_new_connection can block for the full connect
    # timeout on an unreachable frame, and holding the lock there would stall all
    # SSH activity to every other frame. A concurrent caller may create a second
    # connection for the same key in the meantime, which the pool tolerates.
    new_ssh = await _create_new_connection(db, redis, frame)
    pc = PooledConnection(new_ssh)
    pc.mark_in_use()

    async with _pool_lock:
        _ssh_pool.setdefault(pool_key, []).append(pc)

    return new_ssh


async def remove_ssh_connection(db, redis, ssh: asyncssh.SSHClientConnection, frame: Frame):
    """
    Release the SSH connection back to the pool so it can be reused or closed after IDLE_TIMEOUT_SECONDS.
    """
    if not ssh:
        return

    async with _pool_lock:
        # Found by the connection itself, not by a key worked out again from
        # the frame: the row may have changed (a new password, the host key
        # recorded by this very connect) since the connection was taken.
        for pool_key, connections in _ssh_pool.items():
            for pc in connections:
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

    # 1) If password is set, just do password-based auth
    # 2) Otherwise, load the private key from DB
    client_keys = []
    keypair_label = None
    if not password:
        # Attempt to load SSH keys from DB
        private_keys, keypair_label = _frame_private_keys(db, frame)
        if not private_keys:
            raise Exception("No SSH private keys available for this frame.")
        for private_key in private_keys:
            try:
                private_key_obj = asyncssh.import_private_key(private_key)
            except (asyncssh.KeyImportError, TypeError):
                raise Exception("Could not parse the private key from DB. Check if it's valid PEM.")
            client_keys.append(private_key_obj)

    await log(
        db, redis, frame.id, "stdinfo",
        f"Connecting via SSH to {username}@{host} "
        f"({'password' if password else f'keypair: {keypair_label}'})"
    )

    # Trust on first use: the key recorded on the frame row pins every later
    # connect; with none recorded yet, whatever this connect is offered gets
    # recorded below (app/utils/ssh_host_keys.py).
    stored_host_key = getattr(frame, "ssh_host_key", None) or None
    try:
        known_hosts = trusted_known_hosts(stored_host_key)
    except ValueError as exc:
        raise Exception(f"{exc}. Forget the stored host key in the frame's SSH settings and connect again.")

    try:
        ssh = await asyncssh.connect(
            host=host,
            port=port,
            username=username,
            password=password if password else None,
            client_keys=client_keys if not password else None,
            known_hosts=known_hosts,
            # A powered-off frame must not hang the caller on the OS TCP
            # timeout (minutes) — arq worker slots and API requests wait on this.
            connect_timeout=30,
            login_timeout=30,
        )
    except asyncssh.HostKeyNotVerifiable:
        message = host_key_changed_message(
            f"{host}:{port}", stored_host_key, "forget the stored host key in the frame's SSH settings"
        )
        await log(db, redis, frame.id, "stderr", message)
        raise Exception(message)
    except (OSError, asyncssh.Error) as exc:
        raise Exception(f"Unable to connect to {host}:{port} via SSH: {exc}")

    await log(db, redis, frame.id, "stdinfo", f"SSH connection established to {username}@{host}")
    if not stored_host_key:
        await _record_frame_host_key(db, redis, frame, ssh)
    return ssh


async def _record_frame_host_key(db, redis, frame, ssh: asyncssh.SSHClientConnection) -> None:
    key = ssh.get_server_host_key()
    if key is None:
        return
    line = openssh_host_key_line(key)
    frame.ssh_host_key = line
    if isinstance(frame, Frame) and db is not None and redis is not None:
        await update_frame(db, redis, frame)
    await log(
        db, redis, frame.id, "stdinfo",
        f"Recorded the frame's SSH host key ({host_key_type(line)} {host_key_fingerprint(line)}); "
        "later connections refuse any other key",
    )


async def exec_command(
    db: Session,
    redis: ArqRedis,
    frame: Frame,
    ssh: asyncssh.SSHClientConnection,
    command: str,
    output: Optional[list[str]] = None,
    log_output: bool = True,
    log_command: bool | str = True,
    raise_on_error: bool = True,
    timeout: int = 300,
) -> int:
    """
    Execute a command on the remote host using an existing SSH connection.
    Stream stdout and stderr lines as they arrive, optionally storing them
    into 'output' and logging them in the database.
    Returns the process exit status. Kills the remote process and raises if
    it runs longer than `timeout` seconds, so a hung command can't pin the
    pooled SSH connection (and the API request waiting on it) forever.
    """

    if log_command:
        await log(db, redis, frame.id, "stdout", f"> {log_command if isinstance(log_command, str) else command}")

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

        try:
            response = await asyncio.wait_for(process.wait(), timeout=timeout)
        except asyncio.TimeoutError:
            process.kill()
            stdout_task.cancel()
            stderr_task.cancel()
            # TimeoutError, like the Remote path (remote_exec._exec_via_remote).
            raise TimeoutError(f"Command '{command}' timed out after {timeout}s")

        await asyncio.gather(stdout_task, stderr_task)
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
