// Etcito community levels service: a small HTTP store for level packs (packages/game/src/levelPack.ts).
//   GET    /levels          public list (newest first), no pack bodies
//   GET    /levels/<id>     public: the pack as one JSON
//   POST   /levels          Authorization: Bearer <write key>; body = a pack; strict validation, 201 {id, contentHash}
//   DELETE /levels/<id>     Authorization: Bearer <write key>
// Every response (errors and OPTIONS included) carries Access-Control-Allow-Origin: * and
// Cross-Origin-Resource-Policy: cross-origin. The write key is read from LEVELS_WRITE_KEY (a service environment file),
// never from the repo, never logged. Storage: one <id>.json per level in LEVELS_DIR (atomic write).
// Deployed as one bundle (tools/levels/deploy.sh); runs behind nginx on 127.0.0.1.
import { createHash, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { isRefusal } from '@royal-fiesta/sim/refusal'
import { LEVEL_LIMITS, validateLevelPack } from '../../packages/game/src/levelPack.ts'
import type { LevelListing, LevelPack } from '../../packages/game/src/levelPack.ts'

const MAX_LEVELS = 200
const ID = /^ugc-[a-z0-9-]{1,36}-[0-9a-f]{8}$/

export interface LevelsOptions { dir: string; writeKey: string; now?: () => number }

const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '600',
  'Cross-Origin-Resource-Policy': 'cross-origin',
} as const

function send(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = body === null ? '' : JSON.stringify(body)
  res.writeHead(status, { ...HEADERS, 'Content-Type': 'application/json; charset=utf-8', ...extra })
  res.end(text)
}

function digest(s: string): Buffer { return createHash('sha256').update(s, 'utf8').digest() }

async function readBody(req: IncomingMessage, max: number): Promise<string | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > max) return null
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export function levelsHandler(options: LevelsOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { dir, writeKey } = options
  const now = options.now ?? Date.now
  mkdirSync(dir, { recursive: true })
  const keyDigest = digest(writeKey)
  const authorized = (req: IncomingMessage): boolean => {
    const h = req.headers.authorization ?? ''
    const m = /^Bearer (\S{1,200})$/.exec(h)
    return m !== null && writeKey.length >= 24 && timingSafeEqual(digest(m[1]), keyDigest)
  }
  const fileOf = (id: string): string => join(dir, `${id}.json`)

  function listing(): LevelListing[] {
    const out: LevelListing[] = []
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json') || !ID.test(name.slice(0, -5))) continue
      const path = join(dir, name)
      try {
        const pack = JSON.parse(readFileSync(path, 'utf8')) as LevelPack
        const m = pack.manifest
        out.push({ id: m.id, title: m.title, author: m.author, gameVersion: m.gameVersion, courseId: m.courseId, contentHash: m.contentHash, size: statSync(path).size, createdAt: Math.floor(statSync(path).mtimeMs) })
      } catch { /* an unreadable file is not listed */ }
    }
    return out.sort((a, b) => b.createdAt - a.createdAt)
  }

  return async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://local')
      const path = url.pathname.replace(/\/+$/, '')
      if (req.method === 'OPTIONS') return send(res, 204, null)
      if (path === '/health') return send(res, 200, { ok: true })
      const sub = /^\/levels(?:\/([^/]+))?$/.exec(path)
      if (sub === null) return send(res, 404, { error: 'not_found' })
      const id = sub[1]
      if (req.method === 'GET' && id === undefined) return send(res, 200, { levels: listing() })
      if (req.method === 'GET') {
        if (!ID.test(id)) return send(res, 404, { error: 'not_found' })
        let text: string
        try { text = readFileSync(fileOf(id), 'utf8') } catch { return send(res, 404, { error: 'not_found' }) }
        res.writeHead(200, { ...HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=31536000, immutable' })
        return void res.end(text)
      }
      if (req.method === 'POST' && id === undefined) {
        if (!authorized(req)) return send(res, 401, { error: 'unauthorized' })
        const body = await readBody(req, LEVEL_LIMITS.maxPackBytes + 65_536)
        if (body === null) return send(res, 413, { error: 'too_large', reason: `the request is over ${LEVEL_LIMITS.maxPackBytes + 65_536} bytes` })
        let json: unknown
        try { json = JSON.parse(body) } catch { return send(res, 400, { error: 'invalid', reason: 'the body is not JSON' }) }
        let level
        try { level = await validateLevelPack(json) } catch (e) {
          return send(res, 422, { error: 'invalid', reason: isRefusal(e) || e instanceof Error ? e.message : String(e) })
        }
        const { manifest } = level.pack
        const exists = (() => { try { statSync(fileOf(manifest.id)); return true } catch { return false } })()
        if (!exists && listing().length >= MAX_LEVELS) return send(res, 507, { error: 'full', reason: `the store holds ${MAX_LEVELS} levels` })
        const tmp = fileOf(manifest.id) + `.${process.pid}.tmp`
        writeFileSync(tmp, JSON.stringify(level.pack))
        renameSync(tmp, fileOf(manifest.id))
        return send(res, exists ? 200 : 201, { id: manifest.id, contentHash: manifest.contentHash, existed: exists, publishedAt: now() })
      }
      if (req.method === 'DELETE' && id !== undefined) {
        if (!authorized(req)) return send(res, 401, { error: 'unauthorized' })
        if (!ID.test(id)) return send(res, 404, { error: 'not_found' })
        try { rmSync(fileOf(id)) } catch { return send(res, 404, { error: 'not_found' }) }
        return send(res, 200, { id, deleted: true })
      }
      return send(res, 405, { error: 'method_not_allowed' })
    } catch (e) {
      console.error('[levels] internal error', e instanceof Error ? e.message : 'unknown')
      return send(res, 500, { error: 'internal' })
    }
  }
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop() ?? '#')) {
  const writeKey = process.env.LEVELS_WRITE_KEY ?? ''
  if (writeKey.length < 24) throw new Error('LEVELS_WRITE_KEY (24+ characters) is not set in the service environment')
  const dir = process.env.LEVELS_DIR ?? './levels-data'
  const port = Number(process.env.LEVELS_PORT ?? 9781)
  const host = process.env.LEVELS_HOST ?? '127.0.0.1'
  createServer(levelsHandler({ dir, writeKey })).listen(port, host, () => console.log(`[levels] listening on ${host}:${port}`))
}
