import { writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

// Child tools resolve paths themselves (including sibling dependencies in build warnings).
// Clean the complete log at the write boundary so paths split across chunks are handled too.
export function relativeProofText(text: string, root: string, home = homedir()): string {
  const paths = path.win32.isAbsolute(root) && !root.startsWith('/') ? path.win32 : path.posix
  const prefixes = [...new Set([root, paths.dirname(root), home])]
    .filter(prefix => prefix !== paths.parse(prefix).root)
    .sort((a, b) => b.length - a.length)
  for (const prefix of prefixes) {
    const relative = paths.relative(root, prefix).replaceAll('\\', '/')
    const forms = [...new Set([prefix, prefix.replaceAll('\\', '/'), prefix.replaceAll('\\', '\\\\')])]
      .sort((a, b) => b.length - a.length)
    for (const form of forms) {
      const escaped = form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const pattern = new RegExp(`${escaped}([\\\\/]+|(?=$|[\\s"'\x60]))`, 'g')
      text = text.replace(pattern, (_match, separator: string) =>
        separator ? (relative ? `${relative}/` : '') : (relative || '.'))
    }
  }
  return text
}

export function writeProofLog(file: string, text: string, root: string): void {
  writeFileSync(file, relativeProofText(text, root))
}
