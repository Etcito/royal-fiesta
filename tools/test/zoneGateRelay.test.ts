import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { exposeAddress } from '../zoneGateRelay.ts'

test('zone gate uses only the exposure service address for each Chrome connection', async () => {
  const previous = process.env.NMC_EXPOSE_URL
  const override = process.env.RF_GATE_RELAY_HOST
  const requests: string[] = []
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`)
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      assert.equal(body, '')
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ host: 'gpu-host', port: 42000 + requests.length,
        address: `gpu-host:${42000 + requests.length}` }))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const addr = server.address()
    assert(addr && typeof addr === 'object')
    process.env.NMC_EXPOSE_URL = `http://127.0.0.1:${addr.port}/nmc/expose/`
    process.env.RF_GATE_RELAY_HOST = 'unsupported-direct-host'
    assert.equal(await exposeAddress(12345), 'gpu-host:42001')
    assert.equal(await exposeAddress(12345), 'gpu-host:42002')
    assert.deepEqual(requests, ['POST /nmc/expose/12345', 'POST /nmc/expose/12345'])
    delete process.env.NMC_EXPOSE_URL
    assert.throws(() => exposeAddress(12345), /missing supported GPU exposure route/)
  } finally {
    if (previous === undefined) delete process.env.NMC_EXPOSE_URL
    else process.env.NMC_EXPOSE_URL = previous
    if (override === undefined) delete process.env.RF_GATE_RELAY_HOST
    else process.env.RF_GATE_RELAY_HOST = override
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})
