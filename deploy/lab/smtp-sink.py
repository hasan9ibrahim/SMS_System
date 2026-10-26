# Lab-only SMTP catcher for the rehearsal lab (deploy/lab/README.md): accepts every message on 10.88.0.1:2525 and
# writes it to a file in the folder given (no TLS, any login). Fake data only.
#   python3 deploy/lab/smtp-sink.py deploy/lab/mail
import asyncio, sys, time, os
OUT = sys.argv[1]
os.makedirs(OUT, exist_ok=True)
async def handle(r, w):
    async def send(s): w.write((s + "\r\n").encode()); await w.drain()
    await send("220 lab-sink ESMTP")
    data_mode, buf = False, []
    while True:
        line = await r.readline()
        if not line: break
        if data_mode:
            if line in (b".\r\n", b".\n"):
                fn = os.path.join(OUT, f"{time.time():.6f}.eml")
                open(fn, "wb").write(b"".join(buf)); buf = []; data_mode = False
                await send("250 OK queued")
            else: buf.append(line)
            continue
        cmd = line.decode(errors="replace").strip().upper()
        if cmd.startswith(("EHLO", "HELO")): w.write(b"250-lab-sink\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n"); await w.drain()
        elif cmd.startswith("AUTH"): await send("235 OK")
        elif cmd.startswith(("MAIL", "RCPT", "RSET", "NOOP")): await send("250 OK")
        elif cmd.startswith("DATA"): data_mode = True; await send("354 go")
        elif cmd.startswith("QUIT"): await send("221 bye"); break
        else: await send("250 OK")
    w.close()
async def main():
    s = await asyncio.start_server(handle, "10.88.0.1", 2525)
    async with s: await s.serve_forever()
asyncio.run(main())
