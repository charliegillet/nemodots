"""Offline tests for ratchet.sandbox (owner: I1). Docker tests are opt-in (RATCHET_DOCKER_TESTS=1)."""
from __future__ import annotations

import shutil
import sys
import tempfile
import time
from pathlib import Path

import pytest

from ratchet.sandbox import Sandbox, run_pytest, run_python_file, truncate_middle


@pytest.fixture
def sb(settings):
    settings.sandbox_backend = "subprocess"   # these tests are about the subprocess backend
    return Sandbox(settings)


def test_backend_forced_subprocess(sb):
    assert sb.backend == "subprocess"


def test_echo(sb, tmp_path):
    res = sb.run(["python", "-c", "print('hello')"], tmp_path)
    assert res.exit_code == 0 and res.stdout.strip() == "hello" and not res.timed_out
    assert res.backend == "subprocess" and res.duration_s >= 0


def test_nonzero_exit_and_stderr(sb, tmp_path):
    res = sb.run(["python", "-c", "import sys; sys.stderr.write('boom'); sys.exit(3)"], tmp_path)
    assert res.exit_code == 3 and "boom" in res.stderr


def test_timeout_kills(sb, tmp_path):
    t0 = time.monotonic()
    res = sb.run(["python", "-c", "import time; time.sleep(30)"], tmp_path, timeout_s=1)
    assert res.timed_out and res.exit_code == 124
    assert time.monotonic() - t0 < 10


def test_timeout_kills_process_group(sb, tmp_path):
    code = ("import subprocess, sys, time\n"
            "subprocess.Popen([sys.executable, '-c', 'import time,pathlib; time.sleep(3); "
            "pathlib.Path(\"child_alive\").write_text(\"1\")'])\n"
            "time.sleep(30)\n")
    (tmp_path / "spawn.py").write_text(code)
    res = run_python_file(sb, tmp_path, "spawn.py", timeout_s=1)
    assert res.timed_out
    time.sleep(3.5)
    assert not (tmp_path / "child_alive").exists()


def test_output_capped(sb, tmp_path):
    res = sb.run(["python", "-c", "print('x' * 100000); print('END')"], tmp_path)
    assert res.exit_code == 0
    assert len(res.stdout) < 20200 and "truncated" in res.stdout and res.stdout.rstrip().endswith("END")


def test_env_isolation(sb, tmp_path, monkeypatch):
    monkeypatch.setenv("RATCHET_PARENT_ONLY", "leak")
    code = ("import os; print(os.environ.get('RATCHET_PARENT_ONLY')); print(os.environ.get('CRUSOE_API_KEY')); "
            "print(os.environ['HOME']); print(os.environ['PYTHONHASHSEED'])")
    res = sb.run(["python", "-c", code], tmp_path, env={"EXTRA": "1"})
    lines = res.stdout.split()
    assert lines[0] == "None" and lines[1] == "None"
    assert lines[2] == str(tmp_path.resolve()) and lines[3] == "0"
    assert sb.run(["python", "-c", "import os; print(os.environ['EXTRA'])"], tmp_path,
                  env={"EXTRA": "1"}).stdout.strip() == "1"


def test_python_file_can_import_workspace_module(sb, tmp_path):
    (tmp_path / "solution.py").write_text("def f():\n    return 42\n")
    (tmp_path / "snippet.py").write_text("from solution import f\nprint(f())\n")
    res = run_python_file(sb, tmp_path, "snippet.py", timeout_s=10)
    assert res.exit_code == 0 and res.stdout.strip() == "42"


def test_run_pytest_ignores_repo_config(sb, tmp_path):
    (tmp_path / "pytest.ini").write_text("[pytest]\naddopts = --collect-only\n")
    (tmp_path / "test_a.py").write_text("def test_a():\n    assert False\n")
    res = run_pytest(sb, tmp_path, ["test_a.py"], timeout_s=20)
    assert res.exit_code == 1 and "1 failed" in res.stdout


def test_truncate_middle():
    assert truncate_middle("abc", 10) == "abc"
    out = truncate_middle("a" * 3000 + "b" * 2000 + "c" * 1000, 4000)
    assert out.startswith("a" * 3000) and out.endswith("c" * 1000) and "[truncated 2000 chars]" in out


@pytest.fixture
def shared_tmp():
    """A temp dir under the repo (runs/ is gitignored): Docker VMs such as colima share only $HOME."""
    from ratchet.config import ROOT

    base = ROOT / "runs"
    base.mkdir(exist_ok=True)
    d = Path(tempfile.mkdtemp(prefix="_pytest_docker_", dir=base))
    yield d
    shutil.rmtree(d, ignore_errors=True)


@pytest.mark.docker
def test_docker_backend(settings, shared_tmp):
    tmp_path = shared_tmp
    settings.sandbox_backend = "docker"
    sb = Sandbox(settings)
    assert sb.backend == "docker"
    (tmp_path / "solution.py").write_text("def f():\n    return 7\n")
    res = sb.run(["python", "-c", "import solution, socket\nprint(solution.f())\n"
                  "try:\n    socket.create_connection(('1.1.1.1', 80), timeout=2); print('net')\n"
                  "except OSError:\n    print('nonet')"], tmp_path)
    assert res.exit_code == 0, res.stderr
    assert res.stdout.split() == ["7", "nonet"] and res.backend == "docker"
    assert not (tmp_path / "_ratchet_mount_probe").exists()
    res = sb.run(["python", "-c", "import time; time.sleep(30)"], tmp_path, timeout_s=1)
    assert res.timed_out and res.exit_code == 124
    (tmp_path / "test_x.py").write_text("from solution import f\ndef test_f():\n    assert f() == 7\n")
    res = run_pytest(sb, tmp_path, ["test_x.py"], timeout_s=30)
    assert res.exit_code == 0 and "1 passed" in res.stdout


@pytest.mark.docker
def test_docker_unshared_dir_falls_back(settings, tmp_path):
    """tmp_path (/private/var/folders/...) is not shared with colima's VM: in auto mode the mount probe must
    make the sandbox fall back to subprocess and still return the correct result; in strict docker mode
    it must fail closed instead (exit 125, never run outside docker)."""
    settings.sandbox_backend = "auto"
    sb = Sandbox(settings)
    (tmp_path / "solution.py").write_text("def f():\n    return 9\n")
    res = sb.run(["python", "-c", "import solution; print(solution.f())"], tmp_path)
    assert res.exit_code == 0 and res.stdout.strip() == "9"
    settings.sandbox_backend = "docker"
    strict = Sandbox(settings)
    res = strict.run(["python", "-c", "import solution; print(solution.f())"], tmp_path)
    assert res.exit_code == 125 and res.backend == "docker" and strict.backend == "docker"



# --------------------------------------------------------------------------- isolation


def test_strict_docker_fails_closed(settings, monkeypatch, tmp_path):
    from ratchet.sandbox import SandboxUnavailable

    settings.sandbox_backend = "docker"
    monkeypatch.setattr(Sandbox, "docker_available", staticmethod(lambda: False))
    monkeypatch.setattr(Sandbox, "_docker_reason", "docker CLI not installed")
    sb = Sandbox(settings)
    with pytest.raises(SandboxUnavailable, match="failing closed"):
        sb.run(["python", "-c", "print(1)"], tmp_path)


def test_strict_docker_never_switches_to_subprocess(settings, monkeypatch, tmp_path):
    from ratchet.sandbox import SandboxResult

    settings.sandbox_backend = "docker"
    sb = Sandbox(settings)
    sb._backend = "docker"
    calls = []

    def fake_docker(argv, workdir, timeout, env):
        calls.append(argv)
        return SandboxResult(exit_code=125, stdout="", stderr="docker: daemon gone", timed_out=False, backend="docker",
                             duration_s=0.0, isolation="container")

    monkeypatch.setattr(sb, "_run_docker", fake_docker)
    monkeypatch.setattr(sb, "_run_subprocess", lambda *a, **k: pytest.fail("strict mode ran code outside docker"))
    res = sb.run(["python", "-c", "print(1)"], tmp_path)
    assert res.exit_code == 125 and res.backend == "docker" and len(calls) == 2 and sb.backend == "docker"


def test_auto_mode_still_falls_back(settings, monkeypatch, tmp_path):
    settings.sandbox_backend = "auto"
    monkeypatch.setattr(Sandbox, "docker_available", staticmethod(lambda: False))
    sb = Sandbox(settings)
    assert sb.backend == "subprocess"
    assert sb.run(["python", "-c", "print(5)"], tmp_path).stdout.strip() == "5"


@pytest.mark.skipif(sys.platform != "darwin" or not Path("/usr/bin/sandbox-exec").exists(), reason="macOS seatbelt only")
def test_seatbelt_blocks_secrets_and_network(sb, tmp_path):
    secret = tmp_path / "secret.env"
    secret.write_text("TOP_SECRET_VALUE")
    work = tmp_path / "work" / "deep"
    work.mkdir(parents=True)
    code = ("import socket\n"
            "try:\n    print(open('../../secret.env').read())\nexcept OSError as e:\n    print('noread', type(e).__name__)\n"
            "open('inside.txt', 'w').write('x')\n"
            "try:\n    socket.create_connection(('1.1.1.1', 80), timeout=2); print('NET')\nexcept OSError:\n    print('nonet')\n")
    # tmp_path is outside $HOME; hide it explicitly the way the repo is hidden in real runs
    import ratchet.sandbox as sbm
    orig = sbm.seatbelt_profile
    sbm_profile = lambda w, **kw: orig(w, **kw).replace("(allow file-read-metadata)",  # noqa: E731
                                            f'(deny file-read* (literal "{secret.resolve()}"))\n(allow file-read-metadata)')
    try:
        sbm.seatbelt_profile = sbm_profile
        res = sb.run(["python", "-c", code], work)
    finally:
        sbm.seatbelt_profile = orig
    assert res.isolation == "seatbelt", res.stderr
    assert "TOP_SECRET_VALUE" not in res.stdout and "noread PermissionError" in res.stdout
    assert "nonet" in res.stdout and (work / "inside.txt").exists()


@pytest.mark.skipif(sys.platform != "darwin" or not Path("/usr/bin/sandbox-exec").exists(), reason="macOS seatbelt only")
def test_seatbelt_profile_hides_home_and_repo(sb):
    from ratchet.config import ROOT
    from ratchet.sandbox import seatbelt_profile

    prof = seatbelt_profile(ROOT / "runs" / "x")
    assert "(deny network*)" in prof
    assert f'(subpath "{Path.home().resolve()}")' in prof and f'(subpath "{ROOT.resolve()}")' in prof
    assert "(deny file-write* (require-not" in prof


_SEATBELT = pytest.mark.skipif(sys.platform != "darwin" or not Path("/usr/bin/sandbox-exec").exists(),
                               reason="macOS seatbelt only")


@_SEATBELT
def test_seatbelt_hides_sibling_runs_outside_repo(settings, tmp_path):
    """RATCHET_RUNS_DIR outside $HOME and the repo: a workspace cannot read another run's hidden tests."""
    settings.sandbox_backend = "subprocess"
    settings.runs_dir = tmp_path / "ext-runs"
    sibling = settings.runs_dir / "versions" / "v0" / "holdout" / "t11" / "r0" / "verify"
    sibling.mkdir(parents=True)
    (sibling / "test_hidden.py").write_text("HIDDEN_TEST_BODY")
    work = settings.runs_dir / "versions" / "v1" / "train" / "t01" / "r0" / "workspace"
    work.mkdir(parents=True)
    (work.parent / "transcript.json").write_text("PARENT_SECRET")
    code = ("import os\n"
            "for p in ('../../../../../v0/holdout/t11/r0/verify/test_hidden.py', '../transcript.json'):\n"
            "    try:\n        print('READ', open(p).read())\n    except OSError as e:\n        print('denied', type(e).__name__)\n"
            "try:\n    print(os.listdir('..'))\nexcept OSError as e:\n    print('nolist', type(e).__name__)\n"
            "open('ok.txt', 'w').write('x'); print(open('ok.txt').read())\n")
    res = Sandbox(settings).run(["python", "-c", code], work)
    assert res.isolation == "seatbelt", res.stderr
    assert "HIDDEN_TEST_BODY" not in res.stdout and "PARENT_SECRET" not in res.stdout, res.stdout
    assert res.stdout.count("denied PermissionError") == 2 and "nolist PermissionError" in res.stdout
    assert res.stdout.strip().endswith("x")


@_SEATBELT
def test_seatbelt_limits_exec_and_temp_writes(sb, tmp_path):
    """No exec of arbitrary binaries (osascript, ls); python and /bin/sh still work; writes only to the
    workdir and a private TMPDIR that is removed afterwards."""
    code = ("import os, subprocess, sys, tempfile\n"
            "for cmd in (['/usr/bin/osascript', '-e', 'return 1'], ['/bin/ls', '/']):\n"
            "    try:\n        subprocess.run(cmd, capture_output=True); print('EXEC', cmd[0])\n"
            "    except PermissionError:\n        print('noexec', cmd[0])\n"
            "print(subprocess.run([sys.executable, '-c', 'print(7)'], capture_output=True, text=True).stdout.strip())\n"
            "print(subprocess.run(['/bin/sh', '-c', 'echo shok'], capture_output=True, text=True).stdout.strip())\n"
            "with tempfile.NamedTemporaryFile() as f:\n    f.write(b'x'); print('tmpok', os.environ['TMPDIR'])\n"
            "try:\n    open('/private/var/folders/ratchet_probe_should_fail', 'w'); print('VARWRITE')\n"
            "except OSError:\n    print('novarwrite')\n")
    res = sb.run(["python", "-c", code], tmp_path)
    assert res.isolation == "seatbelt", res.stderr
    out = res.stdout
    assert "noexec /usr/bin/osascript" in out and "noexec /bin/ls" in out and "EXEC" not in out, out
    assert "\n7\n" in out and "shok" in out and "novarwrite" in out and "VARWRITE" not in out, out
    tmpdir = next(line.split(" ", 1)[1] for line in out.splitlines() if line.startswith("tmpok "))
    assert "ratchet-sbx-" in tmpdir and not Path(tmpdir).exists()


@_SEATBELT
def test_seatbelt_profile_tightened(settings, tmp_path):
    from ratchet.sandbox import seatbelt_profile

    prof = seatbelt_profile(tmp_path / "runs" / "a" / "work", runs_dir=tmp_path / "runs", tmpdir=tmp_path / "t")
    assert "(deny process-exec*)" in prof and "(deny mach-lookup)" in prof
    assert '"/private/var/folders"' not in prof
    assert f'(subpath "{(tmp_path / "runs").resolve()}")' in prof


def test_seatbelt_can_be_disabled(settings, tmp_path):
    settings.sandbox_backend = "subprocess"
    settings.sandbox_seatbelt = False
    res = Sandbox(settings).run(["python", "-c", "print(1)"], tmp_path)
    assert res.isolation == "none" and res.stdout.strip() == "1"
