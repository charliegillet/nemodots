"""Sandboxed command execution for Ratchet (owner: I1).

Two backends behind one :class:`Sandbox`:

* ``docker``: ``docker run --rm --network none --cpus .. --memory .. --pids-limit 256 --user uid:gid``
  with the workdir bind-mounted at ``/work`` (image ``settings.sandbox_image``, built on demand from
  ``docker/sandbox/Dockerfile``).
* ``subprocess``: the venv interpreter (``sys.executable``, which has pytest) with ``cwd=workdir``,
  a minimal environment and its own process group (killed on timeout).

``argv[0] == "python"`` is a logical name. Backend resolution for ``auto``: docker when
``docker info`` answers and the image exists or builds; otherwise subprocess (one WARNING per
process). If an ``auto`` docker run fails at the docker level (exit 125/126/127 and stderr mentions
docker/daemon) the instance switches to subprocess for the rest of the process and re-runs that command.

``RATCHET_SANDBOX=docker`` FAILS CLOSED: if docker is unavailable ``backend`` raises
:class:`SandboxUnavailable`, and a docker-level error is retried once in docker and otherwise returned
as a failed result; model-written code never runs outside the container.

Subprocess isolation: on macOS (``sandbox-exec`` present, ``settings.sandbox_seatbelt``) every
subprocess run is wrapped in a seatbelt profile that denies all network access (including unix
sockets such as the docker socket), denies reads under ``$HOME`` and the repository except the
workdir and the venv, and denies writes outside the workdir and temp dirs, so ``../../.env`` cannot be
read. ``SandboxResult.isolation`` says what applied: ``"container"``, ``"seatbelt"`` or ``"none"``
(unsandboxed: plain subprocess on a host without seatbelt, flagged in RunResult and the report).

Choices where PLAN.md is silent or had to be adjusted (see the I1 report):
* ``python <file>`` under the subprocess backend runs as ``python -E -s <file>`` rather than
  ``python -I <file>``: ``-I`` also implies ``-P``, which drops the script directory from
  ``sys.path`` so ``import solution`` from a snippet or witness file would fail. ``-E -s`` keeps the
  isolation that matters (ignore ``PYTHON*`` env vars and the user site directory).
* ``run_pytest`` adds ``-c /dev/null --rootdir=.`` so pytest never discovers the repository's
  ``pyproject.toml`` (workdirs live under ``runs/`` inside the repo; its ``addopts`` would otherwise
  change verbosity and its ``pythonpath`` would expose the ``ratchet`` package), and so a
  ``pytest.ini`` written into a workspace cannot alter how hidden tests run. ``--confcutdir=.`` stops
  conftest discovery at the workdir, and keeps pytest from listing the workdir's ancestors (the seatbelt
  profile denies directory listings outside the workdir and the Python install).
* Output is captured by reader threads that keep a bounded head (15000) and tail (5000) of each
  stream (20000 per stream), so a runaway ``print`` loop cannot exhaust memory.
* Docker runs also get ``--security-opt no-new-privileges`` and ``-e HOME=/tmp``, and are wrapped in
  ``sh -c`` with a mount probe (``_ratchet_mount_probe`` written to the workdir for the duration of
  the run): Docker VMs such as colima share only some host paths (``$HOME`` by default) and silently
  mount an empty directory otherwise, so an unshared workdir becomes a docker-level error (exit 125)
  and triggers the subprocess fallback instead of failing every verification.
"""
from __future__ import annotations

import logging
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path

from ratchet.config import ROOT, Settings

log = logging.getLogger("ratchet.sandbox")

OUTPUT_CAP = 20000
DOCKERFILE_DIR = ROOT / "docker" / "sandbox"
_DOCKER_LEVEL_EXIT = {125, 126, 127}
MOUNT_PROBE = "_ratchet_mount_probe"


def truncate_middle(text: str, max_chars: int, head: int | None = None) -> str:
    """Keep ``head`` leading and ``max_chars - head`` trailing chars with a marker in between.

    Default split is 3/4 head, 1/4 tail (4000 -> 3000 + 1000, as in PLAN.md 4.6)."""
    if max_chars <= 0 or len(text) <= max_chars:
        return text
    if head is None:
        head = (max_chars * 3) // 4
    head = max(0, min(head, max_chars))
    tail = max_chars - head
    dropped = len(text) - head - tail
    return text[:head] + f"\n...[truncated {dropped} chars]...\n" + (text[-tail:] if tail else "")


@dataclass
class SandboxResult:
    exit_code: int
    stdout: str
    stderr: str
    timed_out: bool
    backend: str
    duration_s: float
    isolation: str = ""          # "container" | "seatbelt" | "none"


class SandboxUnavailable(RuntimeError):
    """RATCHET_SANDBOX=docker was requested but docker cannot be used (fail closed)."""


SEATBELT_BIN = "/usr/bin/sandbox-exec"


def _sb_quote(path: str) -> str:
    return '"' + path.replace("\\", "\\\\").replace('"', '\\"') + '"'


# Mach services a sandboxed Python run may look up (everything else is denied): user/group lookups
# (pwd.getpwuid, getpass.getuser -> pytest's tmp_path), notifications/timezone and the system logger.
SEATBELT_MACH_ALLOW = (
    "com.apple.system.opendirectoryd.libinfo",
    "com.apple.system.opendirectoryd.membership",
    "com.apple.system.DirectoryService.libinfo_v1",
    "com.apple.system.notification_center",
    "com.apple.system.logger",
    "com.apple.logd",
    "com.apple.diagnosticd",
    "com.apple.trustd",
    "com.apple.trustd.agent",
)


SEATBELT_SHELLS = ("/bin/sh", "/bin/bash", "/bin/zsh", "/bin/dash")


def _python_exec_paths() -> set[str]:
    """Directories whose binaries a sandboxed run may exec: the venv and the Python install it uses."""
    real = lambda p: os.path.realpath(str(p))  # noqa: E731
    paths = {real(sys.prefix), real(sys.base_prefix), real(Path(sys.executable).parent),
             real(Path(real(sys.executable)).parent)}
    return {p for p in paths if p and p != "/"}


def seatbelt_profile(workdir: Path, *, runs_dir: Path | None = None, tmpdir: Path | None = None) -> str:
    """macOS sandbox profile for one subprocess run (last matching rule wins).

    * no network, no process exec except the Python install / venv and ``/bin/sh``, no Mach lookups
      except ``SEATBELT_MACH_ALLOW`` (so model code cannot drive other apps, e.g. ``osascript``);
    * reads denied under ``$HOME``, the repository, ``runs_dir`` and the workdir's parent (sibling run
      dirs hold hidden tests and near-correct mutants), then re-allowed for the workdir, ``tmpdir`` and
      the Python install;
    * writes only to the workdir, ``tmpdir`` (the run's private TMPDIR) and ``/dev``. Without a
      ``tmpdir`` the per-user temp tree ``/private/var/folders`` stays writable (legacy callers).
    """
    real = lambda p: os.path.realpath(str(p))  # noqa: E731
    home = real(Path.home())
    work = real(workdir)
    py = _python_exec_paths()
    readable = {work, *py}
    hidden = {home, real(ROOT)}
    if runs_dir is not None:
        hidden.add(real(runs_dir))
    parent = real(Path(work).parent)
    if parent not in ("/", "/private", "/private/var", "/private/tmp", "/tmp", "/Users") and len(parent) > 1:
        hidden.add(parent)
    writable = {work, "/dev"}
    if tmpdir is not None:
        readable.add(real(tmpdir))
        writable.add(real(tmpdir))
    else:
        writable.add("/private/var/folders")
    lines = ["(version 1)", "(allow default)", "(deny network*)"]
    lines.append("(deny process-exec*)")
    # /bin/sh on macOS is a shim that re-execs the shell named by /private/var/select/sh.
    lines.append("(allow process-exec " + " ".join(f"(subpath {_sb_quote(p)})" for p in sorted(py))
                 + " " + " ".join(f"(literal {_sb_quote(sh)})" for sh in SEATBELT_SHELLS) + ")")
    lines.append("(deny mach-lookup)")
    lines.append("(allow mach-lookup " + " ".join(f"(global-name {_sb_quote(n)})" for n in SEATBELT_MACH_ALLOW) + ")")
    lines.append("(deny file-read* " + " ".join(f"(subpath {_sb_quote(h)})" for h in sorted(hidden)) + ")")
    lines.append("(allow file-read* " + " ".join(f"(subpath {_sb_quote(r)})" for r in sorted(readable)) + ")")
    # stat() everywhere (pytest and the import system stat the workdir's ancestors), but no directory
    # listings outside the readable set: os.listdir() of an ancestor would reveal other task ids and file
    # names such as .env.
    lines.append("(allow file-read-metadata)")
    lines.append("(deny file-write* (require-not (require-any "
                 + " ".join(f"(subpath {_sb_quote(w)})" for w in sorted(writable)) + ")))")
    return "\n".join(lines) + "\n"


class _BoundedReader(threading.Thread):
    """Drains a pipe, keeping the first 3/4 and the last 1/4 of ``cap`` bytes (head + tail)."""

    def __init__(self, stream, cap: int):
        super().__init__(daemon=True)
        self.stream = stream
        self.head_cap = (cap * 3) // 4
        self.tail_cap = cap - self.head_cap
        self.head = bytearray()
        self.tail = bytearray()
        self.total = 0

    def run(self) -> None:
        try:
            while True:
                chunk = self.stream.read(65536)
                if not chunk:
                    break
                self.total += len(chunk)
                room = self.head_cap - len(self.head)
                if room > 0:
                    self.head += chunk[:room]
                    chunk = chunk[room:]
                if chunk:
                    self.tail += chunk
                    if len(self.tail) > self.tail_cap:
                        del self.tail[: len(self.tail) - self.tail_cap]
        except (OSError, ValueError):
            pass
        finally:
            try:
                self.stream.close()
            except OSError:
                pass

    def text(self) -> str:
        head = self.head.decode("utf-8", errors="replace")
        tail = self.tail.decode("utf-8", errors="replace")
        dropped = self.total - len(self.head) - len(self.tail)
        if dropped <= 0:
            return head + tail
        return head + f"\n...[truncated {dropped} bytes]...\n" + tail


def _run_bounded(cmd: list[str], *, cwd: str | None, env: dict[str, str] | None, timeout_s: float,
                 on_timeout, new_session: bool) -> tuple[int, str, str, bool, float]:
    """Run ``cmd`` capturing bounded output. ``on_timeout(proc)`` must terminate the work."""
    t0 = time.monotonic()
    proc = subprocess.Popen(cmd, cwd=cwd, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, start_new_session=new_session)
    out_r = _BoundedReader(proc.stdout, OUTPUT_CAP)
    err_r = _BoundedReader(proc.stderr, OUTPUT_CAP)
    out_r.start()
    err_r.start()
    timed_out = False
    try:
        rc = proc.wait(timeout=timeout_s)
    except subprocess.TimeoutExpired:
        timed_out = True
        try:
            on_timeout(proc)
        finally:
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
        rc = 124
    out_r.join(timeout=5)
    err_r.join(timeout=5)
    return rc, out_r.text(), err_r.text(), timed_out, time.monotonic() - t0


class Sandbox:
    _docker_ok: bool | None = None          # process-wide cache for docker_available()
    _docker_reason: str = ""
    _image_ok: dict[str, bool] = {}         # image -> ensure_image() result
    _class_lock = threading.Lock()
    _warned_fallback = False
    _seatbelt_ok: bool | None = None        # process-wide: sandbox-exec usable here
    _warned_unsandboxed = False

    def __init__(self, settings: Settings):
        self.settings = settings
        self._backend: str | None = None
        self._lock = threading.Lock()

    # ------------------------------------------------------------------ backend resolution
    @staticmethod
    def docker_available() -> bool:
        """``docker info`` exits 0 within 5 s. Cached per process."""
        with Sandbox._class_lock:
            if Sandbox._docker_ok is not None:
                return Sandbox._docker_ok
            try:
                r = subprocess.run(["docker", "info", "--format", "{{.ServerVersion}}"], capture_output=True,
                                   text=True, timeout=5)
                ok = r.returncode == 0
                Sandbox._docker_reason = "" if ok else (r.stderr.strip().splitlines() or ["docker info failed"])[-1][:200]
            except FileNotFoundError:
                ok, Sandbox._docker_reason = False, "docker CLI not installed"
            except subprocess.TimeoutExpired:
                ok, Sandbox._docker_reason = False, "docker info timed out"
            except OSError as exc:
                ok, Sandbox._docker_reason = False, f"docker not runnable: {exc}"
            Sandbox._docker_ok = ok
            return ok

    def ensure_image(self) -> bool:
        """Build ``settings.sandbox_image`` from docker/sandbox if missing. False on failure."""
        image = self.settings.sandbox_image
        with Sandbox._class_lock:
            if image in Sandbox._image_ok:
                return Sandbox._image_ok[image]
            ok = False
            try:
                r = subprocess.run(["docker", "image", "inspect", image], capture_output=True, timeout=30)
                if r.returncode == 0:
                    ok = True
                elif (DOCKERFILE_DIR / "Dockerfile").exists():
                    log.info("sandbox: building docker image %s from %s", image, DOCKERFILE_DIR)
                    b = subprocess.run(["docker", "build", "-t", image, str(DOCKERFILE_DIR)], capture_output=True,
                                       text=True, timeout=900)
                    ok = b.returncode == 0
                    if not ok:
                        Sandbox._docker_reason = "image build failed: " + (b.stderr.strip().splitlines() or [""])[-1][:200]
                else:
                    Sandbox._docker_reason = f"image {image} missing and no Dockerfile at {DOCKERFILE_DIR}"
            except (OSError, subprocess.TimeoutExpired) as exc:
                Sandbox._docker_reason = f"image check failed: {type(exc).__name__}"
            Sandbox._image_ok[image] = ok
            return ok

    @classmethod
    def _warn_fallback(cls, reason: str) -> None:
        with cls._class_lock:
            if cls._warned_fallback:
                return
            cls._warned_fallback = True
        log.warning("sandbox: docker unavailable (%s), falling back to subprocess", reason)

    @property
    def strict(self) -> bool:
        """RATCHET_SANDBOX=docker: never run model code outside docker."""
        return (self.settings.sandbox_backend or "auto").strip().lower() == "docker"

    @property
    def backend(self) -> str:
        """Resolved backend: "docker" | "subprocess". Raises SandboxUnavailable in strict docker mode."""
        with self._lock:
            if self._backend is not None:
                return self._backend
            wanted = (self.settings.sandbox_backend or "auto").strip().lower()
            if wanted == "subprocess":
                self._backend = "subprocess"
            elif wanted in ("auto", "docker"):
                if self.docker_available() and self.ensure_image():
                    self._backend = "docker"
                elif wanted == "docker":
                    raise SandboxUnavailable("RATCHET_SANDBOX=docker requested but "
                                             + (Sandbox._docker_reason or "docker is unavailable")
                                             + " (failing closed; set RATCHET_SANDBOX=auto to allow the subprocess backend)")
                else:
                    self._backend = "subprocess"
                    self._warn_fallback(Sandbox._docker_reason or "unknown reason")
            else:
                log.warning("sandbox: unknown backend %r, using subprocess", wanted)
                self._backend = "subprocess"
            return self._backend

    def seatbelt_available(self) -> bool:
        """sandbox-exec works on this host (macOS). Probed once per process."""
        if not self.settings.sandbox_seatbelt or sys.platform != "darwin" or not os.path.exists(SEATBELT_BIN):
            return False
        with Sandbox._class_lock:
            if Sandbox._seatbelt_ok is None:
                try:
                    r = subprocess.run([SEATBELT_BIN, "-p", "(version 1)(allow default)(deny network*)", "/usr/bin/true"],
                                       capture_output=True, timeout=10)
                    Sandbox._seatbelt_ok = r.returncode == 0
                except (OSError, subprocess.TimeoutExpired):
                    Sandbox._seatbelt_ok = False
                if not Sandbox._seatbelt_ok:
                    log.warning("sandbox: sandbox-exec is not usable here; subprocess runs are UNSANDBOXED")
            return Sandbox._seatbelt_ok

    def _warn_unsandboxed(self) -> None:
        with Sandbox._class_lock:
            if Sandbox._warned_unsandboxed:
                return
            Sandbox._warned_unsandboxed = True
        log.warning("sandbox: running model-written code as a plain subprocess (no network or filesystem "
                    "isolation); runs are marked unsandboxed. Use docker (RATCHET_SANDBOX=docker) for real runs.")

    def _switch_to_subprocess(self, reason: str) -> None:
        with self._lock:
            self._backend = "subprocess"
        log.warning("sandbox: docker run failed (%s); switching to subprocess for the rest of this process", reason)

    # ------------------------------------------------------------------ running
    def run(self, argv: list[str], workdir: Path, timeout_s: int | None = None,
            env: dict[str, str] | None = None) -> SandboxResult:
        if not argv:
            raise ValueError("empty argv")
        workdir = Path(workdir).resolve()
        workdir.mkdir(parents=True, exist_ok=True)
        timeout = int(timeout_s if timeout_s is not None else self.settings.sandbox_timeout_s)
        if self.backend == "docker":
            res = self._run_docker(argv, workdir, timeout, env)
            if self._docker_level_error(res):
                why = res.stderr.strip().splitlines()[-1][:200] if res.stderr.strip() else ""
                if self.strict:  # fail closed: retry once in docker, never fall back
                    log.warning("sandbox: docker-level error (%s); retrying once in docker (strict mode)", why)
                    return self._run_docker(argv, workdir, timeout, env)
                self._switch_to_subprocess(why)
                return self._run_subprocess(argv, workdir, timeout, env)
            return res
        return self._run_subprocess(argv, workdir, timeout, env)

    @staticmethod
    def _docker_level_error(res: SandboxResult) -> bool:
        return (res.exit_code in _DOCKER_LEVEL_EXIT and not res.timed_out
                and any(w in res.stderr.lower() for w in ("docker", "daemon")))

    def _run_subprocess(self, argv: list[str], workdir: Path, timeout: int,
                        env: dict[str, str] | None) -> SandboxResult:
        cmd = list(argv)
        if cmd[0] == "python":
            cmd[0] = sys.executable
            if len(cmd) > 1 and cmd[1] != "-m":
                cmd[1:1] = ["-E", "-s"]
        isolation = "none"
        run_tmp: str | None = None
        if self.seatbelt_available():
            # A private TMPDIR per run: the profile then allows writes only there and in the workdir
            # (not the whole per-user /private/var/folders tree shared with every other app).
            run_tmp = tempfile.mkdtemp(prefix="ratchet-sbx-")
            cmd = [SEATBELT_BIN, "-p", seatbelt_profile(workdir, runs_dir=self.settings.runs_dir,
                                                        tmpdir=Path(run_tmp)), *cmd]
            isolation = "seatbelt"
        else:
            self._warn_unsandboxed()
        full_env = {
            "PATH": os.environ.get("PATH", os.defpath),
            "HOME": str(workdir),
            "PYTHONDONTWRITEBYTECODE": "1",
            "PYTHONHASHSEED": "0",
        }
        if run_tmp:
            full_env["TMPDIR"] = run_tmp
        if env:
            full_env.update({str(k): str(v) for k, v in env.items()})
        try:
            return self._exec_subprocess(cmd, workdir, timeout, full_env, isolation)
        finally:
            if run_tmp:
                shutil.rmtree(run_tmp, ignore_errors=True)

    def _exec_subprocess(self, cmd: list[str], workdir: Path, timeout: int, full_env: dict[str, str],
                         isolation: str) -> SandboxResult:

        def kill_group(proc: subprocess.Popen) -> None:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError, OSError):
                proc.kill()

        try:
            rc, out, err, timed_out, dur = _run_bounded(cmd, cwd=str(workdir), env=full_env, timeout_s=timeout,
                                                        on_timeout=kill_group, new_session=True)
        except OSError as exc:
            return SandboxResult(exit_code=127, stdout="", stderr=f"sandbox: could not start process: {exc}",
                                 timed_out=False, backend="subprocess", duration_s=0.0, isolation=isolation)
        if timed_out:
            err = (err + f"\n[sandbox] timed out after {timeout}s").lstrip("\n")
        return SandboxResult(exit_code=rc, stdout=out, stderr=err, timed_out=timed_out, backend="subprocess",
                             duration_s=round(dur, 3), isolation=isolation)

    def _run_docker(self, argv: list[str], workdir: Path, timeout: int,
                    env: dict[str, str] | None) -> SandboxResult:
        s = self.settings
        name = f"ratchet-{uuid.uuid4().hex[:8]}"
        cmd = ["docker", "run", "--rm", "--name", name, "--network", "none", "--cpus", str(s.sandbox_cpus),
               "--memory", str(s.sandbox_memory), "--pids-limit", "256", "--security-opt", "no-new-privileges",
               "--user", f"{os.getuid()}:{os.getgid()}", "-e", "PYTHONDONTWRITEBYTECODE=1",
               "-e", "PYTHONHASHSEED=0", "-e", "HOME=/tmp"]
        for k, v in (env or {}).items():
            cmd += ["-e", f"{k}={v}"]
        # Mount probe: Docker VMs (colima, Docker Desktop) only share some host paths and silently
        # mount an empty directory otherwise. Exit 125 with "docker" in stderr triggers the fallback.
        probe = workdir / MOUNT_PROBE
        try:
            probe.write_text("1", encoding="utf-8")
        except OSError:
            pass
        cmd += ["-v", f"{workdir}:/work", "-w", "/work", s.sandbox_image, "sh", "-c",
                f'[ -e /work/{MOUNT_PROBE} ] || {{ echo "docker: workdir not shared with the docker VM" >&2; '
                f'exit 125; }}; exec "$@"', "sh", *argv]

        def kill_container(proc: subprocess.Popen) -> None:
            try:
                subprocess.run(["docker", "kill", name], capture_output=True, timeout=15)
            except (OSError, subprocess.TimeoutExpired):
                pass
            proc.kill()

        try:
            rc, out, err, timed_out, dur = _run_bounded(cmd, cwd=None, env=None, timeout_s=timeout + 5,
                                                        on_timeout=kill_container, new_session=False)
        except OSError as exc:
            return SandboxResult(exit_code=127, stdout="", stderr=f"sandbox: docker could not start: {exc}", isolation="container",
                                 timed_out=False, backend="docker", duration_s=0.0)
        finally:
            try:
                probe.unlink()
            except OSError:
                pass
        if timed_out:
            err = (err + f"\n[sandbox] timed out after {timeout}s").lstrip("\n")
        return SandboxResult(exit_code=rc, stdout=out, stderr=err, timed_out=timed_out, backend="docker", isolation="container",
                             duration_s=round(dur, 3))


def run_python_file(sandbox: Sandbox, workdir: Path, relpath: str, timeout_s: int) -> SandboxResult:
    return sandbox.run(["python", relpath], workdir, timeout_s=timeout_s)


def run_pytest(sandbox: Sandbox, workdir: Path, targets: list[str], timeout_s: int) -> SandboxResult:
    argv = ["python", "-m", "pytest", "-q", "-x", "-p", "no:cacheprovider", "-c", "/dev/null", "--rootdir=.",
            "--confcutdir=.", *targets]
    return sandbox.run(argv, workdir, timeout_s=timeout_s)
