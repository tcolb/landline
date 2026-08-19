"""M2 e2e: container environments (via stub runtime) and templates."""
import json, os, shutil, socket, subprocess, tempfile, time

SOCK = os.environ.get("XDG_RUNTIME_DIR", "/tmp") + "/landline.sock"
STATE = os.environ["LANDLINE_STUB_STATE"]

def conn():
    s = socket.socket(socket.AF_UNIX); s.connect(SOCK); return s

def rpc(s, req): s.sendall((json.dumps(req)+"\n").encode())

def recv_line(s, timeout=10):
    s.settimeout(timeout); buf = b""
    while b"\n" not in buf:
        chunk = s.recv(1 << 20)
        if not chunk: raise EOFError
        buf += chunk
    return json.loads(buf.split(b"\n", 1)[0])

def rowtext(row):
    return "".join((c["t"] or " ") for c in row["cells"] if not (c["fl"] & 64)).rstrip()

def snap_text(session, timeout=10):
    a = conn(); rpc(a, {"type": "attach", "session": session})
    deadline = time.time() + timeout
    text = []
    a.settimeout(timeout); buf = b""
    while time.time() < deadline:
        try: chunk = a.recv(1 << 22)
        except socket.timeout: break
        if not chunk: break
        buf += chunk
        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1)
            msg = json.loads(line)
            if msg["type"] == "frame" and msg["frame"]["kind"] == "snapshot":
                text = [rowtext(r) for r in msg["frame"]["lines"]]
        if text: break
    a.close()
    return text

def spawn(**kw):
    base = {"template": None, "params": {}, "name": None, "cmd": None,
            "cwd": None, "env": None, "image": None, "rows": 24, "cols": 80}
    base.update(kw)
    s = conn(); rpc(s, {"type": "spawn", "spawn": base})
    resp = recv_line(s)
    assert resp["type"] == "spawned", resp
    s.close()
    return resp["info"]

# --- 1. container spawn renders like host spawn ---
CMD = ["sh", "-c", "echo CONTAINER_HELLO; echo -n 'container '; echo works; sleep 20"]
host = spawn(name="m2host", cmd=CMD)
box = spawn(name="m2box", cmd=CMD, image="testimg:1")
assert host["environment"] == "host", host
assert box["environment"] == "container:testimg:1", box
time.sleep(0.7)
th, tb = snap_text("m2host"), snap_text("m2box")
assert th[:3] == tb[:3] != [], (th[:3], tb[:3])
assert th[0] == "CONTAINER_HELLO"
print("container render parity ok:", th[:2])

# stub recorded the container
name = f"landline-{box['id']}"
assert os.path.exists(f"{STATE}/{name}.json"), os.listdir(STATE)
print("container recorded ok:", name)

# --- 2. kill removes the container ---
s = conn(); rpc(s, {"type": "kill", "session": "m2box"})
assert recv_line(s)["type"] == "ok"
time.sleep(0.7)
assert not os.path.exists(f"{STATE}/{name}.json"), "container not cleaned up"
print("kill removes container ok")

# --- 3. mixed fleet visible in ls ---
s = conn(); rpc(s, {"type": "ls"})
sessions = {x["name"]: x for x in recv_line(s)["sessions"]}
assert sessions["m2host"]["environment"] == "host"
assert sessions["m2box"]["environment"] == "container:testimg:1"
assert sessions["m2box"]["status"]["state"] == "exited"
print("mixed fleet ls ok")

# --- 4. template: repo-local, params, env vars, setup, container env ---
proj = tempfile.mkdtemp(prefix="landline-proj-")
os.makedirs(f"{proj}/.landline/templates")
os.makedirs(f"{proj}/.landline/environments")
with open(f"{proj}/.landline/environments/box.toml", "w") as f:
    f.write('type = "container"\nimage = "tmplimg:9"\n')
with open(f"{proj}/.landline/templates/job.toml", "w") as f:
    f.write('''
schema = 1
[params]
who = { default = "world" }
mode = { required = true }

[environment]
use = "box"

[harness]
cmd = ["sh", "-c", "echo RUN who=$WHO mode=$MODE dir=$(basename $(pwd)); sleep 20"]

[setup]
run = ["echo SETUP for {{who}}"]

[env]
WHO = "{{who}}"
MODE = "{{mode}}"
''')

def run_template(n):
    info = spawn(name=f"job{n}", template="job", params={"mode": "fast"}, cwd=proj)
    assert info["environment"] == "container:tmplimg:9", info
    time.sleep(0.7)
    t = snap_text(f"job{n}")
    assert t[0] == "SETUP for world", t[:3]
    expect = f"RUN who=world mode=fast dir={os.path.basename(proj)}"
    assert t[1] == expect, (t[:3], expect)

run_template(1)
run_template(2)  # twice from one definition: the reliability guarantee
print("template spawn (twice, container env, params, setup, env vars) ok")

# missing required param errors cleanly
s = conn()
rpc(s, {"type": "spawn", "spawn": {"template": "job", "params": {}, "cwd": proj,
        "rows": 24, "cols": 80, "name": None, "cmd": None, "env": None, "image": None}})
resp = recv_line(s)
assert resp["type"] == "error" and "mode" in resp["message"], resp
print("required param validation ok")

shutil.rmtree(proj)
print("ALL CONTAINER/TEMPLATE TESTS PASSED")

# --- 5. worktree workspace strategy ---
repo = tempfile.mkdtemp(prefix="landline-repo-")
G = ["git", "-C", repo, "-c", "user.name=e2e", "-c", "user.email=e2e@test"]
subprocess.run(["git", "-C", repo, "init", "-q", "-b", "main"], check=True)
open(f"{repo}/marker.txt", "w").write("on-main\n")
subprocess.run(G + ["add", "."], check=True)
subprocess.run(G + ["commit", "-qm", "main"], check=True)
subprocess.run(G + ["checkout", "-qb", "feat"], check=True)
open(f"{repo}/marker.txt", "w").write("on-feat\n")
subprocess.run(G + ["commit", "-qam", "feat"], check=True)
subprocess.run(G + ["checkout", "-qm", "main"], check=True)
os.makedirs(f"{repo}/.landline/templates")
with open(f"{repo}/.landline/templates/wt.toml", "w") as f:
    f.write('''
[params]
branch = { required = true }

[workspace]
strategy = "worktree"
ref = "{{branch}}"

[harness]
cmd = ["sh", "-c", "echo MARKER=$(cat marker.txt); sleep 20"]
''')
info = spawn(name="wtjob", template="wt", params={"branch": "feat"}, cwd=repo)
assert info["environment"] == "host"
assert "worktrees" in info["cwd"] and info["cwd"].endswith("-feat"), info["cwd"]
time.sleep(0.7)
t = snap_text("wtjob")
assert t[0] == "MARKER=on-feat", t[:2]
print("worktree strategy ok:", info["cwd"])
subprocess.run(["git", "-C", repo, "worktree", "remove", "--force", info["cwd"]], check=True)

# --- 6. clone workspace strategy: repo URL -> mirror cache -> worktree ---
proj2 = tempfile.mkdtemp(prefix="landline-clone-proj-")
os.makedirs(f"{proj2}/.landline/templates")
with open(f"{proj2}/.landline/templates/repo-agent.toml", "w") as f:
    f.write("""
[params]
repo = { required = true }
ref = { default = "main" }

[workspace]
strategy = "clone"
repo = "{{repo}}"
ref = "{{ref}}"

[harness]
cmd = ["sh", "-c", "echo CLONED=$(cat marker.txt); sleep 20"]
""")
info = spawn(name="clonejob", template="repo-agent",
             params={"repo": f"file://{repo}", "ref": "feat"}, cwd=proj2)
assert "worktrees" in info["cwd"] and info["cwd"].endswith("-feat"), info["cwd"]
time.sleep(0.7)
t = snap_text("clonejob")
assert t[0] == "CLONED=on-feat", t[:2]
# spawn a second from the same repo: cache reuse, distinct worktree
info2 = spawn(name="clonejob2", template="repo-agent",
              params={"repo": f"file://{repo}", "ref": "main"}, cwd=proj2)
assert info2["cwd"] != info["cwd"], (info["cwd"], info2["cwd"])
time.sleep(0.7)
t2 = snap_text("clonejob2")
assert t2[0] == "CLONED=on-main", t2[:2]
print("clone strategy ok:", info["cwd"])
shutil.rmtree(proj2)
shutil.rmtree(repo)

print("ALL CONTAINER/TEMPLATE TESTS PASSED (incl. worktree, clone)")
