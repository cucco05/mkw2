import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  buildDemoModelFiles,
  buildPrintLabPrintersFixture,
  buildPrintLabFixtures,
  buildStockWorksDemoPayloads,
  explainDatabaseTarget,
  resolveSiblingRepoPath,
  resolveSuiteDemoPaths,
} from '../scripts/suite-demo-seed'

// An absolute path that is absolute on the platform the test runs on (a drive letter on Windows, a root on POSIX): nothing about a developer's machine, and nothing has to exist on disk.
const suiteRoot = path.resolve(path.sep, 'suite-workspace', 'GitHub')
const makerworksRoot = path.join(suiteRoot, 'mkwV2')

test('resolveSiblingRepoPath resolves suite repos beside MakerWorks', () => {
  assert.ok(path.isAbsolute(makerworksRoot))
  for (const name of ['stockworks', 'printlab']) {
    const sibling = resolveSiblingRepoPath(makerworksRoot, name)
    assert.ok(path.isAbsolute(sibling), `${name} is absolute`)
    assert.equal(path.dirname(sibling), path.dirname(makerworksRoot), `${name} has the same parent as MakerWorks`)
    assert.equal(path.basename(sibling), name)
    assert.equal(path.relative(makerworksRoot, sibling), path.join('..', name), `${name} sits beside MakerWorks, not inside it`)
    assert.notEqual(sibling, makerworksRoot)
  }
  // a trailing separator on the MakerWorks root changes nothing
  assert.equal(resolveSiblingRepoPath(makerworksRoot + path.sep, 'stockworks'), resolveSiblingRepoPath(makerworksRoot, 'stockworks'))
  // a relative root is resolved against the working directory, so the sibling is still absolute and still beside it
  const relative = resolveSiblingRepoPath(path.join('.', 'mkwV2'), 'stockworks')
  assert.ok(path.isAbsolute(relative))
  assert.equal(path.relative(path.resolve('mkwV2'), relative), path.join('..', 'stockworks'))
})

test('resolveSuiteDemoPaths puts StockWorks and PrintLab beside MakerWorks, and the environment overrides them', () => {
  const beside = resolveSuiteDemoPaths({ makerworksRoot, env: {} })
  assert.equal(path.dirname(beside.stockworksRoot), suiteRoot)
  assert.equal(path.basename(beside.stockworksRoot), 'stockworks')
  assert.equal(path.dirname(beside.printlabRoot), suiteRoot)
  assert.equal(path.basename(beside.printlabRoot), 'printlab')
  assert.equal(path.relative(beside.printlabRoot, beside.printlabDataDir), 'data', 'the PrintLab data directory is inside PrintLab by default')

  const stockworksOverride = path.resolve(path.sep, 'elsewhere', 'stockworks-copy')
  const printlabOverride = path.resolve(path.sep, 'elsewhere', 'printlab-copy')
  const overridden = resolveSuiteDemoPaths({ makerworksRoot, env: { SUITE_DEMO_STOCKWORKS_ROOT: stockworksOverride, SUITE_DEMO_PRINTLAB_ROOT: printlabOverride } })
  assert.equal(overridden.stockworksRoot, stockworksOverride)
  assert.equal(overridden.printlabRoot, printlabOverride)
  assert.equal(overridden.printlabDataDir, path.join(printlabOverride, 'data'), 'the data directory follows the PrintLab override')
  assert.equal(overridden.makerworksRoot, makerworksRoot)
})

test('resolveSuiteDemoPaths keeps PrintLab fixtures in the configured data directory', () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'suite-demo-'))
  const paths = resolveSuiteDemoPaths({
    makerworksRoot: tempRoot,
    env: { SUITE_DEMO_PRINTLAB_DATA_DIR: path.join(tempRoot, 'printlab-data') },
  })

  assert.equal(paths.printlabDataDir, path.join(tempRoot, 'printlab-data'))
  assert.equal(paths.screenshotDir, path.join(tempRoot, 'docs', 'wiki', 'assets', 'suite-screenshots'))
})

test('buildPrintLabFixtures creates deterministic demo job files', () => {
  const fixtures = buildPrintLabFixtures()
  const names = fixtures.map((fixture) => fixture.filename).sort()

  assert.deepEqual(names, [
    'queue_demo-x1c.json',
    'submitted_jobs_demo-x1c.json',
    'successful_gcodes_demo-x1c.json',
  ])
  assert.match(JSON.stringify(fixtures), /MW-DEMO-1001/)
  assert.match(JSON.stringify(fixtures), /PL-DEMO-1001/)
})

test('buildPrintLabPrintersFixture creates a large synthetic printer fleet', () => {
  const printers = buildPrintLabPrintersFixture()

  assert.ok(printers.length >= 8)
  assert.ok(printers.every((printer) => String(printer.id).startsWith('demo-')))
  assert.match(JSON.stringify(printers), /Demo X1 Carbon/)
})

test('buildStockWorksDemoPayloads creates rich inventory and transaction samples', () => {
  const payloads = buildStockWorksDemoPayloads()

  assert.ok(payloads.materials.length >= 10)
  assert.ok(payloads.inventory.length >= 10)
  assert.ok(payloads.hardware.length >= 10)
  assert.ok(payloads.movements.length >= 20)
  assert.match(JSON.stringify(payloads), /MW-DEMO-1001/)
})

test('buildDemoModelFiles creates a real STL preview target for the model viewer', () => {
  const files = buildDemoModelFiles()

  assert.equal(files.modelPath, 'demo/suite/parametric-enclosure-kit.stl')
  assert.equal(files.viewerPath, files.modelPath)
  assert.match(files.stlContent, /^solid makerworks_demo_enclosure/)
  assert.match(files.stlContent, /endsolid makerworks_demo_enclosure\s*$/)
})

test('buildDemoModelFiles includes legacy cached viewer paths with STL content', () => {
  const files = buildDemoModelFiles()

  assert.deepEqual(files.compatibilityPaths.sort(), [
    'demo/parametric-enclosure-kit.3mf',
    'demo/parametric-enclosure-kit.glb',
  ])
})

test('explainDatabaseTarget identifies Docker-only database hostnames', () => {
  const explanation = explainDatabaseTarget('postgresql://postgres:secret@db:5432/makerworks')

  assert.equal(explanation.host, 'db')
  assert.equal(explanation.reachableFromLocalShell, false)
  assert.match(explanation.message, /Docker Compose service hostname/)
})
