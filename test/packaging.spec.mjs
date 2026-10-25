/**
 * Packaging receipts: what the *published* artifact needs, asserted at test time.
 *
 * Every failure below is silent — the suite is green, the build is green, and
 * the consumer gets a package that cannot load. That is the only reason these
 * live in the test suite rather than in a release checklist.
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

/** Every file under `dir` whose name ends with one of `extensions`. */
function walk(dir, extensions, found = []) {
  if (!existsSync(dir)) return found
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path, extensions, found)
    else if (extensions.some((extension) => entry.name.endsWith(extension))) found.push(path)
  }
  return found
}

/**
 * Bare specifiers reached by `import`/`export from`, dynamic `import()`, and
 * `require()` in one source text.
 *
 * Relative and absolute targets are not packages; `node:` builtins are not
 * installable. Both are dropped here rather than filtered per call site.
 */
function bareSpecifiers(source) {
  const specifiers = new Set()
  const patterns = [
    /(?:^|[\s;{])(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]/g,
    /(?:^|[\s;(=])(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /(?:^|[\s;{])import\s*['"]([^'"]+)['"]/g,
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.add(match[1])
  }
  return [...specifiers].filter((specifier) => {
    if (specifier.startsWith('.') || specifier.startsWith('/')) return false
    if (specifier.startsWith('node:')) return false
    return true
  })
}

/** The package a specifier resolves to: `@scope/name` or `name`, subpath dropped. */
function packageOf(specifier) {
  const segments = specifier.split('/')
  return specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0]
}

const runtimeDeclared = new Set([
  ...Object.keys(manifest.dependencies ?? {}),
  ...Object.keys(manifest.peerDependencies ?? {}),
])
const devDeclared = new Set(Object.keys(manifest.devDependencies ?? {}))

const sourceFiles = [...walk(join(ROOT, 'src'), ['.ts']), ...walk(join(ROOT, 'lib'), ['.js'])]
const imported = new Set()
for (const file of sourceFiles) {
  for (const specifier of bareSpecifiers(readFileSync(file, 'utf8'))) imported.add(packageOf(specifier))
}

test('the receipt has something to guard', () => {
  // A walk that silently finds nothing would make the assertions below vacuous.
  assert.ok(sourceFiles.some((file) => file.includes(join('src', 'index.ts'))), 'src/index.ts must be scanned')
  assert.ok(sourceFiles.some((file) => file.endsWith(join('lib', 'index.js'))), 'lib/index.js must be built and scanned')
  assert.ok(imported.size >= 3, `expected several bare imports, saw ${imported.size}`)
})

test('every bare import in the shipped code is declared as a runtime dependency', () => {
  // A value import left in `devDependencies` resolves on the publishing machine
  // and fails for a consumer with ERR_MODULE_NOT_FOUND.
  const undeclared = [...imported].filter((name) => !runtimeDeclared.has(name))
  assert.deepEqual(undeclared, [],
    `imported by shipped code but not declared at runtime: ${undeclared.join(', ')} — a consumer gets ERR_MODULE_NOT_FOUND`)
})

test('no runtime dependency is declared without being imported', () => {
  const unused = [...runtimeDeclared].filter((name) => !imported.has(name))
  assert.deepEqual(unused, [], `declared but never imported by shipped code: ${unused.join(', ')}`)
})

test('test-only packages stay out of the runtime closure', () => {
  // cordis and dsh-llm are deliberately both: peers for consumers, dev deps so
  // this repository can build and test itself.
  const allowed = new Set(Object.keys(manifest.peerDependencies ?? {}))
  const leaked = [...devDeclared].filter((name) => runtimeDeclared.has(name) && !allowed.has(name))
  assert.deepEqual(leaked, [], `a devDependency also declared at runtime: ${leaked.join(', ')}`)
})

test('the shipped file list carries the mount the harness reads', () => {
  // `dsh.bundle.patch` is how a profile finds the mount entry; shipping the
  // package without it — or with a patch that names another plugin — makes the
  // published artifact mount nothing while the install reports success.
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.ok(manifest.files.includes('cordis.patch.yml'), 'the patch file must be in `files`')
  assert.ok(existsSync(join(ROOT, 'cordis.patch.yml')), 'and must exist')
  const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /^\s*- insert:\s*$/m, 'the patch must carry an insert row')
  assert.match(patch, /^\s*-\s+id: orphan-tool-call-guard\s*$/m,
    'the patch must register the id the README documents')
  assert.ok(patch.includes(manifest.name), 'the patch must name this package')
})

test('the entry point ships with the repository, not only with a local build', () => {
  // A git install carries tracked files only, and `lib/` is build output: if it
  // is ignored, `dsh plugin add` attaches a package whose `main` does not exist
  // and the profile mounts nothing while reporting success.
  assert.ok(manifest.files.includes('lib/index.js'), 'the built entry must be in `files`')
  assert.ok(existsSync(join(ROOT, 'lib/index.js')), 'and must exist (run the build)')
  assert.ok(manifest.files.includes('lib/types/**/*.d.ts'), 'the declarations must be in `files` too')
  assert.ok(walk(join(ROOT, 'lib', 'types'), ['.d.ts']).length > 0, 'and must exist (run the build)')

  // Both channels have an ignore file that outranks `files` for what they carry:
  // `.gitignore` decides a git install, `.npmignore` a published tarball. A
  // measured copy of this tree holds neither, and a file that is not there
  // cannot hide anything — so an absent one is skipped rather than required,
  // which is what lets this suite run against a line pinned outside a checkout.
  const rules = ['.gitignore', '.npmignore']
    .filter((name) => existsSync(join(ROOT, name)))
    .flatMap((name) =>
      readFileSync(join(ROOT, name), 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '' && !line.startsWith('#'))
        .map((line) => `${name}: ${line}`),
    )
  const hidingLibrary = rules.filter((rule) => /^\.\w*ignore: \/?lib(\/|$)/.test(rule))
  assert.deepEqual(hidingLibrary, [],
    `no ignore file may hide lib/: ${hidingLibrary.join(', ')} — that channel would ship no entry point`)
})
