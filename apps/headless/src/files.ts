// Node-only file access: repo-relative paths, fixture assets and cached course loads.
import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fixtureResolver, storeResolver } from '@royal-fiesta/game/assets'
import type { AssetResolver } from '@royal-fiesta/game/assets'
import { loadCourse } from '@royal-fiesta/game/course'
import type { ResolvedCourse } from '@royal-fiesta/sim/course'
import { refuse } from '@royal-fiesta/sim/refusal'
import { repoRoot } from '../../../tools/bricks.ts'

const COURSES_DIR = 'fixtures/courses'

export function repoPath(rel: string): string {
  const root = repoRoot()
  const abs = path.resolve(root, rel)
  if (path.isAbsolute(rel) || (abs !== root && !abs.startsWith(root + path.sep))) {
    refuse('files', rel, 'path escapes the repository; use a repo-relative path')
  }
  return abs
}

export async function readRepoText(rel: string): Promise<string> {
  const abs = repoPath(rel)
  try {
    return await readFile(abs, 'utf8')
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    refuse('files', rel, `cannot read: ${err.code ?? err.message}; check the path`)
  }
}

let fixtures: AssetResolver | undefined

export function nodeFixtureResolver(): AssetResolver {
  if (!fixtures) fixtures = fixtureResolver(readRepoText)
  return fixtures
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  let res: Response
  try {
    res = await fetch(url)
  } catch (e) {
    refuse('files', url, `fetch failed: ${(e as Error).message}; check the network and the asset store`)
  }
  if (!res.ok) refuse('files', url, `fetch failed: HTTP ${res.status}; check the manifest and object hashes`)
  return new Uint8Array(await res.arrayBuffer())
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return createHash('sha256').update(bytes).digest('hex')
}

const courses = new Map<string, Promise<ResolvedCourse>>()

async function readCourse(rel: string): Promise<ResolvedCourse> {
  const text = await readRepoText(rel)
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (e) {
    refuse('course', rel, `invalid JSON: ${(e as Error).message}; fix the file syntax`)
  }
  const manifest = (json as { assetsManifest?: unknown } | null)?.assetsManifest
  const resolver = typeof manifest === 'string' ? storeResolver(manifest, fetchBytes, sha256Hex) : nodeFixtureResolver()
  return loadCourse(json, rel, resolver)
}

export async function loadCourseFile(rel: string): Promise<ResolvedCourse> {
  let result = courses.get(rel)
  if (!result) {
    result = readCourse(rel)
    courses.set(rel, result)
  }
  return result
}

export async function loadAllCourses(filter?: (c: ResolvedCourse) => boolean): Promise<ResolvedCourse[]> {
  const entries = await readdir(repoPath(COURSES_DIR), { withFileTypes: true })
  const names = entries.filter(e => e.isFile() && e.name.endsWith('.course.json')).map(e => e.name)
  names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const loaded: ResolvedCourse[] = []
  for (const name of names) loaded.push(await loadCourseFile(`${COURSES_DIR}/${name}`))
  const kept = filter ? loaded.filter(filter) : loaded
  // Load order is part of determinism: code-unit order by id.
  return kept.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}
