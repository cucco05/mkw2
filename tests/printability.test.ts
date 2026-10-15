// Step 4.2-ter (A4, A8): can the shop make a cart line automatically? Pure rules, no database (lib/printability.ts).
import assert from 'node:assert/strict'
import test from 'node:test'
import { evaluateLine, fitsInAnyOrientation, resolveFinishKey, resolveMaterialKey, usableVolume, type LineToCheck, type MachineProfile } from '../lib/printability'

const FINISHES = ['standard', 'matte', 'gloss', 'polished', 'textured']
const a1mini: MachineProfile = {
  key: 'bambu-a1-mini', label: 'Bambu Lab A1 mini', build: { x: 180, y: 180, z: 180 }, marginXYmm: 3, marginZmm: 2, supportMarginXYmm: 3,
  nozzleDiameterMm: 0.4, minFeatureMm: null, maxSupportRatio: null, allowedMaterials: ['PLA', 'PETG', 'TPU'], allowedFinishes: FINISHES,
}
const big: MachineProfile = { ...a1mini, key: 'big', label: 'Big machine', build: { x: 350, y: 350, z: 350 }, allowedMaterials: ['PLA', 'PETG', 'ABS', 'ASA'] }
const line = (over: Partial<LineToCheck> = {}): LineToCheck => ({
  material: 'PLA', finish: null, reference: { sizeXmm: 80, sizeYmm: 60, sizeZmm: 50 }, scales: { x: 1, y: 1, z: 1 }, modelUnit: 'mm', supportRatio: 0, ...over,
})
const verdict = (over: Partial<LineToCheck>, machines = [a1mini], checkGeometry = true) => evaluateLine(line(over), machines, { knownFinishes: FINISHES, checkGeometry })
const codes = (v: ReturnType<typeof verdict>) => (v.ok ? [] : v.reasons.map((r) => r.code))

// ---- materials -------------------------------------------------------------------------------------------------------------------
test('a material is recognised only by its exact name; nothing unknown becomes PLA', () => {
  assert.equal(resolveMaterialKey('PLA'), 'PLA')
  assert.equal(resolveMaterialKey(' petg '), 'PETG')
  for (const unknown of ['PEEK', 'TITANIUM', 'PETG-CF', 'PLA Matte', 'PL A', '', '   ', null, undefined, 'PLA; DROP TABLE', 'nylonn']) {
    if (unknown === '' || unknown === '   ' || unknown == null) { assert.equal(resolveMaterialKey(unknown as any), null, String(unknown)); continue }
    assert.equal(resolveMaterialKey(unknown), unknown === ' petg ' ? 'PETG' : null, String(unknown))
  }
})

test('a finish is recognised only if the shop has a price for it; an empty finish is "standard"', () => {
  assert.equal(resolveFinishKey(null, FINISHES), 'standard')
  assert.equal(resolveFinishKey('', FINISHES), 'standard')
  assert.equal(resolveFinishKey(' Matte ', FINISHES), 'matte')
  assert.equal(resolveFinishKey('gold-plated', FINISHES), null)
  assert.equal(resolveFinishKey('smooth', FINISHES), null)
})

test('an unknown material or finish is never accepted; the reason says which', () => {
  assert.deepEqual(codes(verdict({ material: 'PEEK' })), ['MATERIAL_UNKNOWN'])
  assert.deepEqual(codes(verdict({ finish: 'gold-plated' })), ['FINISH_UNKNOWN'])
  const v = verdict({ material: 'TITANIUM' })
  assert.equal(v.ok, false)
  if (!v.ok) assert.equal(v.reasons[0].value, 'TITANIUM')
})

test('a known material the machine does not offer is not accepted (ABS on an open-frame A1 mini); another machine can offer it', () => {
  assert.deepEqual(codes(verdict({ material: 'ABS' })), ['MATERIAL_NOT_AVAILABLE'])
  assert.deepEqual(codes(verdict({ material: 'RESIN' })), ['MATERIAL_NOT_AVAILABLE'])
  assert.equal(verdict({ material: 'ABS' }, [a1mini, big]).ok, true, 'one machine that can make it is enough')
  assert.equal(verdict({ material: 'ABS' }, [{ ...a1mini, allowedMaterials: ['PLA', 'ABS'] }]).ok, true, 'changing the data is enough, no code')
})

test('a finish the machine does not offer is not accepted', () => {
  assert.deepEqual(codes(verdict({ finish: 'polished' }, [{ ...a1mini, allowedFinishes: ['standard', 'matte'] }])), ['FINISH_NOT_AVAILABLE'])
  assert.equal(verdict({ finish: 'matte' }, [{ ...a1mini, allowedFinishes: ['standard', 'matte'] }]).ok, true)
})

test('with no active machine nothing is accepted automatically', () => {
  assert.deepEqual(codes(evaluateLine(line(), [], { knownFinishes: FINISHES })), ['NO_ACTIVE_MACHINE'])
})

test('materials and finishes can be checked on their own (geometry left out)', () => {
  const v = evaluateLine(line({ reference: null }), [a1mini], { knownFinishes: FINISHES, checkGeometry: false })
  assert.equal(v.ok, true)
})

// ---- build volume ----------------------------------------------------------------------------------------------------------------
test('usable volume = nominal volume minus the margins (and the support margin when supports may be needed)', () => {
  assert.deepEqual(usableVolume(a1mini, false), { x: 174, y: 174, z: 178 })
  assert.deepEqual(usableVolume(a1mini, true), { x: 168, y: 168, z: 178 })
  assert.deepEqual(usableVolume({ ...a1mini, marginXYmm: 100 }, false), { x: 0, y: 0, z: 178 }, 'never negative')
})

test('a model fits when its three sides fit the three axes in SOME orientation', () => {
  const usable = { x: 174, y: 174, z: 178 }
  assert.equal(fitsInAnyOrientation({ x: 170, y: 170, z: 170 }, usable), true)
  assert.equal(fitsInAnyOrientation({ x: 100, y: 100, z: 176 }, usable), true, 'tall but fits')
  assert.equal(fitsInAnyOrientation({ x: 176, y: 100, z: 100 }, usable), true, 'longer than X but fits by turning it up (176 <= 178 in Z)')
  assert.equal(fitsInAnyOrientation({ x: 179, y: 10, z: 10 }, usable), false, 'longer than every axis')
  assert.equal(fitsInAnyOrientation({ x: 175, y: 175, z: 175 }, usable), false, 'two sides over 174')
  assert.equal(fitsInAnyOrientation({ x: 174, y: 174, z: 178 }, usable), true, 'exactly the limit')
  assert.equal(fitsInAnyOrientation({ x: 174.01, y: 174, z: 178 }, usable), false, '178 needs the Z axis, so 174.01 and 174 must both fit the 174 mm axes')
  assert.equal(fitsInAnyOrientation({ x: 178.01, y: 178.01, z: 10 }, usable), false)
})

test('a model larger than the printer, in any orientation, is not accepted and the reason carries the figures', () => {
  const v = verdict({ reference: { sizeXmm: 250, sizeYmm: 120, sizeZmm: 90 } })
  assert.deepEqual(codes(v), ['TOO_LARGE'])
  if (!v.ok) {
    assert.deepEqual(v.reasons[0].sizeMm, { x: 250, y: 120, z: 90 })
    assert.deepEqual(v.reasons[0].usableMm, { x: 174, y: 174, z: 178 }, 'supportRatio 0 in this test: no support margin')
  }
})

test('the scale counts: a model that fits at 1 does not at 3; per-axis scales are applied axis by axis', () => {
  assert.equal(verdict({ reference: { sizeXmm: 80, sizeYmm: 60, sizeZmm: 50 }, scales: { x: 1, y: 1, z: 1 } }).ok, true)
  assert.deepEqual(codes(verdict({ reference: { sizeXmm: 80, sizeYmm: 60, sizeZmm: 50 }, scales: { x: 3, y: 3, z: 3 } })), ['TOO_LARGE'])
  assert.equal(verdict({ reference: { sizeXmm: 80, sizeYmm: 60, sizeZmm: 50 }, scales: { x: 2, y: 2, z: 3 } }).ok, true, '160 x 120 x 150')
  assert.deepEqual(codes(verdict({ reference: { sizeXmm: 80, sizeYmm: 60, sizeZmm: 50 }, scales: { x: 1, y: 1, z: 5 } })), ['TOO_LARGE'], '250 in Z but only 80 x 60 left: needs 250 on some axis')
})

test('supports (or not knowing whether they are needed) take extra margin from the plate', () => {
  const nearlyFull = { sizeXmm: 172, sizeYmm: 172, sizeZmm: 100 }
  assert.equal(verdict({ reference: nearlyFull, supportRatio: 0 }).ok, true, 'no supports needed: 174 mm are usable')
  assert.deepEqual(codes(verdict({ reference: nearlyFull, supportRatio: 0.3 })), ['TOO_LARGE'], 'supports needed: only 168 mm are usable')
  assert.deepEqual(codes(verdict({ reference: nearlyFull, supportRatio: null })), ['TOO_LARGE'], 'support need unknown: treated as needed')
  assert.equal(verdict({ reference: { sizeXmm: 150, sizeYmm: 150, sizeZmm: 100 }, supportRatio: null }).ok, true, 'far from the limit: unknown supports do not block')
})

test('too many supports can send a model to a person when the machine sets a limit', () => {
  const strict = { ...a1mini, maxSupportRatio: 0.5 }
  assert.deepEqual(codes(verdict({ supportRatio: 0.8 }, [strict])), ['SUPPORT_HEAVY'])
  assert.equal(verdict({ supportRatio: 0.4 }, [strict]).ok, true)
  assert.equal(verdict({ supportRatio: 0.9 }).ok, true, 'no limit set: not a reason')
})

test('a side thinner than the machine can print is not accepted (default: the nozzle, or the machine\'s own minimum)', () => {
  assert.deepEqual(codes(verdict({ reference: { sizeXmm: 80, sizeYmm: 60, sizeZmm: 3 }, scales: { x: 1, y: 1, z: 0.1 } })), ['TOO_THIN'], '0.3 mm < 0.4 mm nozzle')
  assert.equal(verdict({ reference: { sizeXmm: 80, sizeYmm: 60, sizeZmm: 3 }, scales: { x: 1, y: 1, z: 0.2 } }).ok, true, '0.6 mm')
  assert.deepEqual(codes(verdict({ reference: { sizeXmm: 80, sizeYmm: 60, sizeZmm: 3 }, scales: { x: 1, y: 1, z: 0.2 } }, [{ ...a1mini, minFeatureMm: 1 }])), ['TOO_THIN'])
})

test('a size that cannot be trusted is never accepted: missing, not in millimetres, implausible', () => {
  assert.deepEqual(codes(verdict({ reference: null })), ['SIZE_UNKNOWN'])
  assert.deepEqual(codes(verdict({ reference: { sizeXmm: 80, sizeYmm: null, sizeZmm: 50 } })), ['SIZE_UNKNOWN'])
  assert.deepEqual(codes(verdict({ reference: { sizeXmm: 80, sizeYmm: 0, sizeZmm: 50 } })), ['SIZE_UNKNOWN'])
  assert.deepEqual(codes(verdict({ reference: { sizeXmm: 80, sizeYmm: -3, sizeZmm: 50 } })), ['SIZE_UNKNOWN'])
  assert.deepEqual(codes(verdict({ reference: { sizeXmm: 80, sizeYmm: Number.NaN, sizeZmm: 50 } })), ['SIZE_UNKNOWN'])
  assert.deepEqual(codes(verdict({ modelUnit: 'in' })), ['UNIT_NOT_MM'])
  assert.deepEqual(codes(verdict({ modelUnit: 'm' })), ['UNIT_NOT_MM'])
  assert.equal(verdict({ modelUnit: 'MM' }).ok, true)
  assert.equal(verdict({ modelUnit: null }).ok, true, 'the column defaults to mm')
  assert.deepEqual(codes(verdict({ reference: { sizeXmm: 0.08, sizeYmm: 0.06, sizeZmm: 0.05 } })), ['SIZE_IMPLAUSIBLE'], 'a 8 cm object in metres')
  assert.deepEqual(codes(verdict({ reference: { sizeXmm: 9000, sizeYmm: 100, sizeZmm: 100 } })), ['SIZE_IMPLAUSIBLE'])
})

test('a PART is checked with its own size, not the size of the whole model', () => {
  const wholeModel = { sizeXmm: 300, sizeYmm: 200, sizeZmm: 100 }
  const part = { sizeXmm: 120, sizeYmm: 90, sizeZmm: 60 }
  assert.deepEqual(codes(verdict({ reference: wholeModel })), ['TOO_LARGE'])
  assert.equal(verdict({ reference: part }).ok, true)
})

test('with several machines the line is accepted if ANY one can make it, and the verdict says which', () => {
  const v = verdict({ material: 'ABS', reference: { sizeXmm: 200, sizeYmm: 200, sizeZmm: 100 } }, [a1mini, big])
  assert.equal(v.ok, true)
  if (v.ok) assert.equal(v.machineKey, 'big')
  // neither machine can: the reasons of the closest one are given
  const no = verdict({ material: 'ABS', reference: { sizeXmm: 400, sizeYmm: 400, sizeZmm: 100 } }, [a1mini, big])
  assert.equal(no.ok, false)
})

test('the reasons of an unreliable size come first and the line is refused even if a machine would otherwise fit it', () => {
  const v = verdict({ reference: { sizeXmm: 80, sizeYmm: null, sizeZmm: 50 }, material: 'ABS' })
  assert.deepEqual(codes(v).slice(0, 2), ['SIZE_UNKNOWN', 'MATERIAL_NOT_AVAILABLE'])
})
