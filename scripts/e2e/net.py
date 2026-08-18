# M3 tests: WebSocket transport, bytes attach, retention, watch, hooks.
import base64, hashlib, json, os, socket, struct, sys, time

SOCK = os.environ.get("XDG_RUNTIME_DIR", "/tmp") + "/landline.sock"
WS_ADDR = os.environ["LANDLINE_WS_ADDR"]
WS_HOST, WS_PORT = WS_ADDR.rsplit(":", 1)
STATE = os.environ["LANDLINE_STUB_STATE"]
TOKEN = open(os.path.expanduser("~/.local/share/landline/ws-token")).read().strip()

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

def b64(data): return base64.b64encode(data).decode()

# --- minimal RFC6455 client (text frames only; server never masks) ---
class WS:
    def __init__(self, path):
        self.sock = socket.create_connection((WS_HOST, int(WS_PORT)))
        key = base64.b64encode(os.urandom(16)).decode()
        req = (f"GET {path} HTTP/1.1\r\nHost: {WS_ADDR}\r\nUpgrade: websocket\r\n"
               f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n"
               f"Sec-WebSocket-Version: 13\r\n\r\n")
        self.sock.sendall(req.encode())
        resp = b""
        while b"\r\n\r\n" not in resp:
            chunk = self.sock.recv(4096)
            if not chunk: break
            resp += chunk
        self.status = int(resp.split(b" ", 2)[1])
        self.buf = resp.split(b"\r\n\r\n", 1)[1] if b"\r\n\r\n" in resp else b""

    def _exact(self, n, timeout):
        self.sock.settimeout(timeout)
        while len(self.buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk: raise EOFError("ws closed")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def send_json(self, obj):
        payload = json.dumps(obj).encode()
        head = bytearray([0x81])
        n = len(payload)
        if n < 126: head.append(0x80 | n)
        elif n < 65536: head += bytes([0x80 | 126]) + struct.pack(">H", n)
        else: head += bytes([0x80 | 127]) + struct.pack(">Q", n)
        mask = os.urandom(4)
        head += mask
        self.sock.sendall(bytes(head) + bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))

    def recv_json(self, timeout=5):
        while True:
            b0, b1 = self._exact(2, timeout)
            op, ln = b0 & 0x0F, b1 & 0x7F
            if ln == 126: ln = struct.unpack(">H", self._exact(2, timeout))[0]
            elif ln == 127: ln = struct.unpack(">Q", self._exact(8, timeout))[0]
            payload = self._exact(ln, timeout)
            if op in (1, 2):
                return json.loads(payload)
            if op == 9:  # ping -> pong
                mask = os.urandom(4)
                self.sock.sendall(bytes([0x8A, 0x80 | len(payload)]) + mask +
                                  bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))
            elif op == 8:
                raise EOFError("ws close frame")

def spawn_req(name, cmd, cwd=None, rows=24, cols=80):
    return {"type": "spawn", "spawn": {"name": name, "cmd": cmd, "cwd": cwd,
            "template": None, "params": {}, "env": None, "image": None,
            "rows": rows, "cols": cols}}

def rowtext(row): return "".join(" " if (c["fl"] & 64) else (c["t"] or " ") for c in row["cells"]).rstrip()

def wait_exited(name):
    for _ in range(100):
        s = conn(); rpc(s, {"type": "ls"}); ls = next(lines(s)); s.close()
        st = [x["status"] for x in ls["sessions"] if x["name"] == name]
        if st and st[0]["state"] == "exited":
            return st[0]
        time.sleep(0.1)
    raise AssertionError(f"{name} never exited")

# 1. bad token is refused at the HTTP layer
bad = WS("/ws?token=wrong")
assert bad.status == 401, bad.status
print("ws auth: bad token rejected (401)")

# 2. hello negotiation over WS
w = WS(f"/ws?token={TOKEN}")
assert w.status == 101, w.status
w.send_json({"type": "hello", "version": 1})
h = w.recv_json()
assert h["type"] == "hello" and h["version"] == 1, h
assert {"frames", "bytes", "watch"} <= set(h["features"]), h
print("ws hello ok:", h["features"])

# 3. spawn + frames attach entirely over WS
w.send_json(spawn_req("net1", ["bash", "-lc", "echo WS_MARKER; exec sleep 30"]))
sp = w.recv_json()
assert sp["type"] == "spawned", sp
time.sleep(0.5)
wa = WS(f"/ws?token={TOKEN}")
wa.send_json({"type": "attach", "session": "net1", "mode": "frames"})
fr = wa.recv_json()
assert fr["type"] == "frame" and fr["frame"]["kind"] == "snapshot", fr
assert any("WS_MARKER" in rowtext(r) for r in fr["frame"]["lines"]), "marker not rendered"
print("ws frames attach ok")

# 4. bytes attach (unix): reconstruction snapshot carries the screen
a = conn()
rpc(a, {"type": "attach", "session": "net1", "mode": "bytes"})
msg = next(lines(a))
assert msg["type"] == "bytes", msg
dump = base64.b64decode(msg["data"])
assert b"WS_MARKER" in dump, dump[:200]
print(f"bytes reconstruction ok ({len(dump)} bytes)")
a.close()

# 5. live bytes stream: input flows in, raw output flows out
s = conn()
rpc(s, spawn_req("net2", ["bash", "-i"]))
assert next(lines(s))["type"] == "spawned"
time.sleep(0.5)
a = conn()
rpc(a, {"type": "attach", "session": "net2", "mode": "bytes"})
first = next(lines(a))
assert first["type"] == "bytes", first
rpc(a, {"type": "input", "data": b64(b"echo LIVE_$((6*7))\r")})
seen = b""
for msg in lines(a, timeout=5):
    if msg["type"] == "bytes":
        seen += base64.b64decode(msg["data"])
        if b"LIVE_42" in seen:
            break
assert b"LIVE_42" in seen, seen[-200:]
print("bytes live stream ok (input -> raw output)")
a.close()

# 6. watch: lifecycle events for a short-lived session, plus hooks
wch = conn()
rpc(wch, {"type": "watch"})
assert next(lines(wch))["type"] == "ok"
s = conn()
rpc(s, spawn_req("net3", ["bash", "-lc", "echo FINAL_MARKER"]))
assert next(lines(s))["type"] == "spawned"
kinds = []
for msg in lines(wch, timeout=5):
    if msg["type"] == "event" and msg["event"]["info"]["name"] == "net3":
        kinds.append(msg["event"]["kind"])
        if kinds == ["created", "exited"]:
            break
assert kinds == ["created", "exited"], kinds
ev_exited = wait_exited("net3")
print("watch ok: created + exited events")

# 7. postmortem attach: retained final screen in both modes
a = conn()
rpc(a, {"type": "attach", "session": "net3", "mode": "frames"})
got = list(lines(a, timeout=3))
assert got[0]["type"] == "frame" and got[0]["frame"]["kind"] == "snapshot", got[:1]
assert any("FINAL_MARKER" in rowtext(r) for r in got[0]["frame"]["lines"]), "final frame lost"
assert got[1]["type"] == "exited", got[1]
a.close()
a = conn()
rpc(a, {"type": "attach", "session": "net3", "mode": "bytes"})
got = list(lines(a, timeout=3))
assert got[0]["type"] == "bytes" and b"FINAL_MARKER" in base64.b64decode(got[0]["data"]), got[:1]
assert got[1]["type"] == "exited", got[1]
print("postmortem attach ok: final screen retained in both modes")
a.close()

# 8. hooks fired with session env vars
hooks_log = os.path.join(STATE, "hooks.log")
deadline = time.time() + 5
entries = ""
while time.time() < deadline:
    entries = open(hooks_log).read() if os.path.exists(hooks_log) else ""
    if "created net3" in entries and "exited net3:0" in entries:
        break
    time.sleep(0.1)
assert "created net3" in entries, entries
assert "exited net3:0" in entries, entries
print("hooks ok:", ", ".join(l for l in entries.splitlines() if "net3" in l))

# cleanup the long-lived sessions
for name in ("net1", "net2"):
    s = conn(); rpc(s, {"type": "kill", "session": name}); next(lines(s)); s.close()

print("ALL NET/INTEROP TESTS PASSED (ws, bytes attach, retention, watch, hooks)")
