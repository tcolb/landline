import json, socket, sys, time, os

SOCK = os.environ.get("XDG_RUNTIME_DIR", "/tmp") + "/landline.sock"

def conn():
    s = socket.socket(socket.AF_UNIX); s.connect(SOCK); return s

def rpc(s, req):
    s.sendall((json.dumps(req) + "\n").encode())

def lines(s, timeout=5):
    s.settimeout(timeout)
    buf = b""
    while True:
        try:
            chunk = s.recv(65536)
        except socket.timeout:
            return
        if not chunk: return
        buf += chunk
        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1)
            yield json.loads(line)

# 1. spawn a session that prints and stays alive
s = conn()
rpc(s, {"type":"spawn","name":"t1","cmd":["bash","-lc","echo HELLO_LANDLINE; printf '\\x1b[31mRED\\x1b[0m\\n'; sleep 30"],"cwd":None,"rows":24,"cols":80})
resp = next(lines(s))
assert resp["type"] == "spawned", resp
sid = resp["info"]["id"]
print("spawned:", sid)

# 2. ls shows it running
rpc(s, {"type":"ls"})
ls = next(lines(s))
assert any(x["id"] == sid and x["status"]["state"] == "running" for x in ls["sessions"]), ls
print("ls ok")

# 3. attach on a fresh connection, expect snapshot containing our output
time.sleep(0.5)
a = conn()
rpc(a, {"type":"attach","session":"t1"})
frame = next(lines(a))
assert frame["type"] == "frame" and frame["frame"]["kind"] == "snapshot", frame
def rowtext(row): return "".join(c["t"] or " " for c in row["cells"]).rstrip()
text = [rowtext(r) for r in frame["frame"]["lines"]]
assert "HELLO_LANDLINE" in text[0], text[:3]
red_row = text[1]
assert "RED" in red_row, text[:3]
# color check: RED cells carry fg rgb
red_cells = [c for c in frame["frame"]["lines"][1]["cells"] if c["t"] in "RED" and c["t"]]
assert any(c["fg"] for c in red_cells), red_cells[:4]
print("snapshot ok: text + color verified;", len(frame["frame"]["lines"]), "rows")

# 4. input: send a command to the shell? (bash -lc is running sleep; skip)
# instead spawn interactive shell and type into it
s2 = conn()
rpc(s2, {"type":"spawn","name":"t2","cmd":["bash","-i"],"cwd":None,"rows":24,"cols":80})
r2 = next(lines(s2)); assert r2["type"]=="spawned", r2
time.sleep(0.5)
b = conn()
rpc(b, {"type":"attach","session":"t2"})
snap = next(lines(b)); assert snap["frame"]["kind"]=="snapshot"
rpc(b, {"type":"input","data":list(b"echo INPUT_$((6*7))\r")})
found = False
deadline = time.time()+5
gen = lines(b, timeout=5)
while time.time() < deadline and not found:
    try: msg = next(gen)
    except StopIteration: break
    if msg["type"]=="frame":
        for r in msg["frame"]["lines"]:
            if "INPUT_42" in rowtext(r): found = True
assert found, "echoed input not seen in diff frames"
print("input->diff ok (INPUT_42 rendered)")

# 5. resize while attached
rpc(b, {"type":"resize","rows":30,"cols":100})
time.sleep(0.5)
c = conn(); rpc(c, {"type":"ls"})
ls2 = next(lines(c))
t2 = [x for x in ls2["sessions"] if x["name"]=="t2"][0]
assert (t2["rows"], t2["cols"]) == (30,100), t2
print("resize ok")

# 6. kill + exit event arrives on attached conn
rpc(c, {"type":"kill","session":"t2"})
assert next(lines(c))["type"] == "ok"
exited = False
for msg in lines(b, timeout=5):
    if msg["type"] == "exited": exited = True; break
assert exited, "no exited event"
print("kill + exited event ok")

# 7. detach/reattach: t1 still running, snapshot instant
a.close()
d = conn(); rpc(d, {"type":"attach","session":"t1"})
t0=time.time(); f2 = next(lines(d)); dt=time.time()-t0
assert f2["frame"]["kind"]=="snapshot"
print(f"reattach snapshot ok in {dt*1000:.0f}ms")

print("ALL SMOKE TESTS PASSED")
