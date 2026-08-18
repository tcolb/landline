#!/usr/bin/env python3
"""Mock landlined for client smoke tests: a stdlib WebSocket server speaking
just enough of the wire protocol (docs/PROTOCOL.md) to let a client list,
attach, and render — one fake session, frames mode only.

Used by CI to drive the mobile app in a simulator with no Rust toolchain.
"""
import base64
import hashlib
import json
import socket
import struct
import threading
import time

HOST, PORT = "127.0.0.1", 7181
GUID = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
ROWS, COLS = 24, 80

INFO = {
    "id": "s1", "name": "mock", "cmd": ["bash"], "cwd": "/tmp",
    "environment": "host", "rows": ROWS, "cols": COLS,
    "status": {"state": "running"},
}

def row(y, text, fg=None):
    cells = [{"t": c, "fg": fg, "bg": None, "fl": 0} for c in text[:COLS]]
    return {"y": y, "cells": cells}

def snapshot():
    lines = [row(0, "MOCK TERMINAL OK", [63, 185, 80]),
             row(1, "if you can read this, the frames renderer works")]
    lines += [{"y": y, "cells": []} for y in range(2, ROWS)]
    return {"kind": "snapshot", "rows": ROWS, "cols": COLS, "lines": lines,
            "cursor": {"x": 0, "y": 4, "visible": True}}

class Conn:
    def __init__(self, sock):
        self.sock = sock
        self.lock = threading.Lock()
        self.buf = b""
        self.alive = True

    def _need(self, n):
        while len(self.buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise EOFError
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def handshake(self):
        data = b""
        while b"\r\n\r\n" not in data:
            chunk = self.sock.recv(4096)
            if not chunk:
                return False
            data += chunk
        key = None
        for line in data.split(b"\r\n"):
            if line.lower().startswith(b"sec-websocket-key:"):
                key = line.split(b":", 1)[1].strip()
        if not key:
            return False
        accept = base64.b64encode(hashlib.sha1(key + GUID).digest()).decode()
        self.sock.sendall(
            ("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n"
             f"Connection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n").encode())
        return True

    def send_json(self, obj):
        payload = json.dumps(obj).encode()
        n = len(payload)
        if n < 126:
            head = struct.pack(">BB", 0x81, n)
        elif n < 65536:
            head = struct.pack(">BBH", 0x81, 126, n)
        else:
            head = struct.pack(">BBQ", 0x81, 127, n)
        with self.lock:
            self.sock.sendall(head + payload)

    def messages(self):
        while True:
            b0, b1 = self._need(2)
            op, ln, masked = b0 & 0xF, b1 & 0x7F, b1 & 0x80
            if ln == 126:
                ln = struct.unpack(">H", self._need(2))[0]
            elif ln == 127:
                ln = struct.unpack(">Q", self._need(8))[0]
            mask = self._need(4) if masked else b"\x00" * 4
            payload = bytes(b ^ mask[i % 4] for i, b in enumerate(self._need(ln)))
            if op == 8:
                return
            if op == 9:
                with self.lock:
                    self.sock.sendall(struct.pack(">BB", 0x8A, len(payload)) + payload)
                continue
            if op in (1, 2):
                yield json.loads(payload)

def ticker(conn):
    n = 0
    while conn.alive:
        time.sleep(1)
        try:
            conn.send_json({"type": "frame", "frame": {
                "kind": "diff",
                "lines": [row(2, f"tick {n}", [88, 166, 255])],
                "cursor": {"x": 0, "y": 4, "visible": True}}})
        except OSError:
            return
        n += 1

def handle(sock, addr):
    conn = Conn(sock)
    try:
        if not conn.handshake():
            return
        attached = False
        for msg in conn.messages():
            t = msg.get("type")
            if t == "hello":
                conn.send_json({"type": "hello", "version": 1,
                                "features": ["frames", "watch", "templates"]})
            elif t == "ls":
                conn.send_json({"type": "sessions", "sessions": [INFO]})
            elif t == "watch":
                conn.send_json({"type": "ok"})
            elif t == "attach":
                print("ATTACHED", msg.get("session"), flush=True)
                conn.send_json({"type": "frame", "frame": snapshot()})
                attached = True
                threading.Thread(target=ticker, args=(conn,), daemon=True).start()
            elif t == "input" and attached:
                data = base64.b64decode(msg["data"])
                conn.send_json({"type": "frame", "frame": {
                    "kind": "diff",
                    "lines": [row(3, f"input: {data!r}", [210, 153, 34])],
                    "cursor": {"x": 0, "y": 4, "visible": True}}})
            elif t == "resize":
                pass  # no response while attached, per protocol
            elif t == "detach":
                return
            elif t == "kill":
                conn.send_json({"type": "ok"})
            else:
                conn.send_json({"type": "error", "message": f"mock: no {t}"})
    except (EOFError, OSError):
        pass
    finally:
        conn.alive = False
        sock.close()

def main():
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind((HOST, PORT))
    srv.listen(8)
    print(f"mock landlined on ws://{HOST}:{PORT}/ws", flush=True)
    while True:
        sock, addr = srv.accept()
        threading.Thread(target=handle, args=(sock, addr), daemon=True).start()

if __name__ == "__main__":
    main()
