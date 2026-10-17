// A TLS reverse proxy for the real-server checks (step 4.6, S5 closure).
//
// In production the app (`next start`) sits behind a proxy that speaks https to the browser and plain http to the app, and tells the app so with
// `X-Forwarded-Proto: https` (lib/guest-cookie-transport.ts). The guest session cookie is `__Host-mw_sid` there, and a browser only keeps a `__Host-` cookie that
// was set over a real https connection (Chrome refuses it even on http://localhost). So the checks that pay as a guest against a production-mode server reach it
// through this proxy: a throw-away self-signed certificate (made with the `openssl` of the machine - no dependency), `ignoreHTTPSErrors` in the browser.
//
// It behaves like the proxy the checklist asks for (docs/CHECKLIST-PRELANCIO.md, 1.54): `X-Forwarded-Proto` is SET (never passed on from the client), the client's
// address is APPENDED to `X-Forwarded-For`, `Host` is kept. Nothing here is used by the application or by `npm test`.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import type { AddressInfo, Socket } from 'node:net'
import os from 'node:os'
import path from 'node:path'

export type TlsProxy = {
  port: number
  // the address a browser or a script uses: https://127.0.0.1:<port>
  origin: string
  stop: () => Promise<void>
}

// A certificate for 127.0.0.1 and localhost that lives one day, in a folder of its own.
export function makeSelfSignedCertificate(): { key: Buffer; cert: Buffer } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkw-tls-'))
  const keyFile = path.join(dir, 'key.pem')
  const certFile = path.join(dir, 'cert.pem')
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile, '-days', '1',
    '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost',
  ], { stdio: 'ignore' })
  const material = { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) }
  fs.rmSync(dir, { recursive: true, force: true })
  return material
}

export async function startTlsProxy(targetPort: number, options: { port?: number } = {}): Promise<TlsProxy> {
  const agent = new http.Agent({ keepAlive: true })
  const sockets = new Set<Socket>()
  const server = https.createServer(makeSelfSignedCertificate(), (req, res) => {
    const headers = { ...req.headers }
    // set, never passed on: whatever the client wrote in these two is gone
    headers['x-forwarded-proto'] = 'https'
    delete headers.forwarded
    const peer = req.socket.remoteAddress || ''
    headers['x-forwarded-for'] = [req.headers['x-forwarded-for'], peer].filter(Boolean).join(', ')
    const upstream = http.request({ host: '127.0.0.1', port: targetPort, method: req.method, path: req.url, headers, agent }, (answer) => {
      res.writeHead(answer.statusCode || 502, answer.headers)
      answer.pipe(res)
    })
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' })
      res.end('bad gateway')
    })
    req.pipe(upstream)
  })
  server.on('secureConnection', (socket) => {
    const raw = socket as unknown as Socket
    sockets.add(raw)
    raw.on('close', () => sockets.delete(raw))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, '127.0.0.1', () => resolve())
  })
  const port = (server.address() as AddressInfo).port
  return {
    port,
    origin: `https://127.0.0.1:${port}`,
    stop: () => new Promise<void>((resolve) => {
      agent.destroy()
      for (const socket of sockets) socket.destroy()
      server.close(() => resolve())
    }),
  }
}
