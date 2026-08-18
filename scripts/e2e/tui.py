import json, socket, time, os
SOCK = os.environ.get("XDG_RUNTIME_DIR", "/tmp") + "/landline.sock"
def conn():
    s = socket.socket(socket.AF_UNIX); s.connect(SOCK); return s
def rpc(s, req): s.sendall((json.dumps(req)+"\n").encode())
def lines(s, timeout=5):
    s.settimeout(timeout); buf=b""
    while True:
        try: chunk = s.recv(1<<20)
        except socket.timeout: return
        if not chunk: return
        buf += chunk
        while b"\n" in buf:
            line, buf = buf.split(b"\n",1); yield json.loads(line)
def rowtext(row): return "".join((c["t"] or " ") for c in row["cells"] if not (c["fl"] & 64)).rstrip()

# vim: alternate screen TUI
s = conn()
rpc(s, {"type":"spawn","spawn":{"name":"vim","cmd":["vim","-u","NONE"],"cwd":None,"rows":24,"cols":80, "template":None,"params":{},"env":None,"image":None}})
r = next(lines(s)); assert r["type"]=="spawned", r
time.sleep(1.0)
a = conn(); rpc(a, {"type":"attach","session":"vim"})
snap = next(lines(a)); text = [rowtext(x) for x in snap["frame"]["lines"]]
tildes = sum(1 for t in text if t.startswith("~"))
assert tildes > 10, (tildes, text)
print(f"vim ok: {tildes} tilde rows, alternate screen rendered")
# type into vim: insert mode, text, back to normal
rpc(a, {"type":"input","data":list(b"iHello from landline\x1b")})
time.sleep(0.5)
found=False
for msg in lines(a, timeout=2):
    if msg["type"]=="frame":
        for row in msg["frame"]["lines"]:
            if "Hello from landline" in rowtext(row): found=True
    if found: break
assert found, "vim edit not rendered"
print("vim editing renders through diffs ok")
rpc(a, {"type":"input","data":list(b":q!\r")})
time.sleep(0.5)

# throughput: 100k lines through the VT
s2 = conn()
rpc(s2, {"type":"spawn","spawn":{"name":"flood","cmd":["bash","-lc","seq 1 100000; echo FLOOD_DONE; sleep 15"],"cwd":None,"rows":24,"cols":80, "template":None,"params":{},"env":None,"image":None}})
next(lines(s2))
t0=time.time()
b = conn(); rpc(b, {"type":"attach","session":"flood"})
done=False
for msg in lines(b, timeout=15):
    if msg["type"]=="frame":
        for row in (msg["frame"]["lines"]):
            if "FLOOD_DONE" in rowtext(row): done=True
    if done: break
assert done, "flood output never completed"
print(f"flood ok: 100k lines digested, DONE visible after {time.time()-t0:.2f}s attach-side")

# unicode/emoji + wide chars
s3 = conn()
rpc(s3, {"type":"spawn","spawn":{"name":"uni","cmd":["bash","-lc","echo '日本語 🚀 café'; sleep 15"],"cwd":None,"rows":24,"cols":80, "template":None,"params":{},"env":None,"image":None}})
next(lines(s3))
time.sleep(0.5)
c = conn(); rpc(c, {"type":"attach","session":"uni"})
snap = next(lines(c))
row0 = snap["frame"]["lines"][0]
t = rowtext(row0)
assert "日本語" in t and "🚀" in t and "café" in t, t
spacers = sum(1 for cell in row0["cells"] if cell["fl"] & 64)
assert spacers >= 4, spacers  # 3 CJK + rocket occupy 2 cols each
print(f"unicode ok: '{t}' with {spacers} wide-spacer cells")

print("ALL TUI TESTS PASSED")
