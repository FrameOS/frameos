import subprocess
from arq import ArqRedis
import asyncssh
import asyncio
from typing import Optional, List
from sqlalchemy.orm import Session
from app.models.log import new_log as log
from app.models.frame import Frame
from app.models.settings import Settings

async def remove_ssh_connection(ssh):
    """
    Close the asyncssh connection.
    """
    if ssh:
        ssh.close()
        # Wait for the connection to be fully closed
        try:
            await ssh.wait_closed()
        except asyncio.CancelledError:
            pass

async def get_ssh_connection(db, redis, frame):
    """
    Create and return an asyncssh connection object to the frame.
    """
    host = frame.frame_host
    port = frame.ssh_port or 22
    username = frame.ssh_user
    password = frame.ssh_pass

    await log(db, redis, frame.id, "stdinfo",
              f"Connecting via SSH to {username}@{host} "
              f"({'password' if password else 'keypair'})")

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
                    # If that fails, see if there's any other fallback
                    raise Exception("Could not parse the private key from DB. "
                                    "Check that it’s in valid PEM format.")

                client_keys = [private_key_obj]
            else:
                raise Exception("Key-based auth chosen but no default key found in DB.")
        else:
            raise Exception("No password set and no SSH keys found in settings. "
                            "Either set a password or store a default key under 'ssh_keys'.")

    try:
        ssh = await asyncssh.connect(
            host=host,
            port=port,
            username=username,
            password=password if password else None,
            client_keys=client_keys if not password else None,
            known_hosts=None  # disable known_hosts checking (or provide a file)
        )
        await log(db, redis, frame.id, "stdinfo",
                  f"SSH connection established to {username}@{host}")
        return ssh
    except (OSError, asyncssh.Error) as exc:
        raise Exception(f"Unable to connect to {host}:{port} via SSH: {exc}")


async def exec_command(db, redis, frame, ssh, command: str,
                       output: Optional[List[str]] = None,
                       log_output: bool = True,
                       raise_on_error: bool = True) -> int:
    """
    Execute a command on the remote host using an existing SSH connection.
    Stream stdout and stderr lines as they arrive, optionally storing them
    into 'output' and logging them in the database.
    Returns the process exit status.
    """

    await log(db, redis, frame.id, "stdout", f"> {command}")

    # We will capture output in these buffers if needed
    stdout_buffer = []
    stderr_buffer = []

    try:
        # Start the remote process
        process = await ssh.create_process(command)

        # Create tasks to read stdout and stderr lines in parallel
        stdout_task = asyncio.create_task(
            _stream_lines(
                db, redis, frame, process.stdout, "stdout",
                log_output, stdout_buffer if output is not None else None
            )
        )
        stderr_task = asyncio.create_task(
            _stream_lines(
                db, redis, frame, process.stderr, "stderr",
                log_output, stderr_buffer if output is not None else None
            )
        )

        # Wait for both streaming tasks to complete
        await asyncio.gather(stdout_task, stderr_task)

        # Wait for the process to exit
        exit_status = process.exit_status

        # If the caller wants the entire stdout combined, put it into output
        # (We only store stdout in `output`, but you can also append stderr if desired.)
        if output is not None:
            stdout_data = "".join(stdout_buffer)
            output.append(stdout_data)

        # Handle non-zero exit
        if exit_status != 0:
            # Grab final aggregated output for the exception details
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
        # If the remote command cannot even be started
        raise Exception(f"Error running command '{command}': {e}") from e


async def _stream_lines(db, redis, frame, stream, log_type: str,
                        log_output: bool, buffer_list: Optional[List[str]]):
    """
    Helper coroutine that reads lines from `stream` (stdout or stderr)
    and writes them to the DB log and/or appends them to buffer_list for
    later use, as each line arrives.
    """
    while True:
        line = await stream.readline()
        if not line:  # no more data
            break

        if buffer_list is not None:
            buffer_list.append(line)

        if log_output:
            # Optionally strip the trailing newline for cleaner logs
            await log(db, redis, frame.id, log_type, line.rstrip('\n'))


async def exec_local_command(db: Session, redis: ArqRedis, frame: Frame, command: str, generate_log = True) -> tuple[int, Optional[str], Optional[str]]:
    if generate_log:
        await log(db, redis, int(frame.id), "stdout", f"$ {command}")
    process = subprocess.Popen(command, shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    errors = []
    outputs = []
    break_next = False

    while True:
        if process.stdout:
            while output := process.stdout.readline():
                await log(db, redis, int(frame.id), "stdout", output)
                outputs.append(output)
        if process.stderr:
            while error := process.stderr.readline():
                await log(db, redis, int(frame.id), "stderr", error)
                errors.append(error)
        if break_next:
            break
        if process.poll() is not None:
            break_next = True
        await asyncio.sleep(0.1)

    exit_status = process.returncode

    if exit_status != 0:
        await log(db, redis, int(frame.id), "exit_status", f"The command exited with status {exit_status}")

    return (exit_status, ''.join(outputs) if len(outputs) > 0 else None, ''.join(errors) if len(errors) > 0 else None)