// A POST to one of the checkout routes for the real-server checks (step 4.6, S5 closure), made with the plain node modules so that the headers are exactly the ones
// given (`undefined` = the header is not sent at all - `fetch` always adds some of its own) and so that the self-signed certificate of the TLS proxy
// (tests/real-run/_tls-proxy.ts) is accepted for this one call only. Not used by the application or by `npm test`.
import http from 'node:http'
import https from 'node:https'

export type Wire = { status: number; headers: http.IncomingHttpHeaders; setCookies: string[]; json: any }

export function wire(base: string, route: string, payload: unknown, headers: Record<string, string | undefined>): Promise<Wire> {
  const url = new URL(`${base}/api/checkout/${route}`)
  const data = JSON.stringify(payload)
  const secure = url.protocol === 'https:'
  const sent: Record<string, string> = { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(data)) }
  for (const [name, value] of Object.entries(headers)) if (value !== undefined) sent[name] = value
  return new Promise((resolve, reject) => {
    const request = (secure ? https : http).request({ hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST', headers: sent, ...(secure ? { rejectUnauthorized: false } : {}) }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        let json: any = null
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { /* not JSON */ }
        resolve({ status: res.statusCode || 0, headers: res.headers, setCookies: res.headers['set-cookie'] ?? [], json })
      })
    })
    request.on('error', reject)
    request.end(data)
  })
}
