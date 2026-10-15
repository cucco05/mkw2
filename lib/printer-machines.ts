// The machines that can make the orders, read from the database (PrinterMachine). Configuration, not code: another machine is another row.
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { MATERIAL_OPTIONS } from '@/lib/cartPricing'
import { knownFinishes } from '@/lib/pricing'
import type { MachineProfile } from '@/lib/printability'

type MachineRow = {
  key: string
  label: string
  buildXmm: number
  buildYmm: number
  buildZmm: number
  marginXYmm: number
  marginZmm: number
  supportMarginXYmm: number
  nozzleDiameterMm: number
  minFeatureMm: number | null
  maxSupportRatio: number | null
  allowedMaterials: string[]
  allowedFinishes: string[]
}

export function toMachineProfile(row: MachineRow): MachineProfile {
  return {
    key: row.key,
    label: row.label,
    build: { x: row.buildXmm, y: row.buildYmm, z: row.buildZmm },
    marginXYmm: row.marginXYmm,
    marginZmm: row.marginZmm,
    supportMarginXYmm: row.supportMarginXYmm,
    nozzleDiameterMm: row.nozzleDiameterMm,
    minFeatureMm: row.minFeatureMm,
    maxSupportRatio: row.maxSupportRatio,
    allowedMaterials: row.allowedMaterials,
    allowedFinishes: row.allowedFinishes,
  }
}

export const machineSelect = {
  key: true, label: true, buildXmm: true, buildYmm: true, buildZmm: true, marginXYmm: true, marginZmm: true, supportMarginXYmm: true,
  nozzleDiameterMm: true, minFeatureMm: true, maxSupportRatio: true, allowedMaterials: true, allowedFinishes: true,
} as const

// Only ACTIVE machines count. With none, nothing can be accepted for automatic payment (every line goes to manual review).
export async function loadActiveMachines(): Promise<MachineProfile[]> {
  const rows = await prisma.printerMachine.findMany({ where: { isActive: true }, orderBy: { createdAt: 'asc' }, select: machineSelect })
  return rows.map(toMachineProfile)
}

// ---- what an administrator may enter ----------------------------------------------------------------------------------------------
const mm = (max: number) => z.number().finite().positive().max(max)
const margin = z.number().finite().min(0).max(100)
const materialName = z.string().trim().toUpperCase().refine((value) => (MATERIAL_OPTIONS as readonly string[]).includes(value), 'unknown material')
const finishName = z.string().trim().toLowerCase().refine((value) => knownFinishes().includes(value), 'unknown finish')

export const machineInputSchema = z.object({
  key: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{1,39}$/, 'lowercase letters, digits and hyphens'),
  label: z.string().trim().min(1).max(80),
  isActive: z.boolean().default(true),
  buildXmm: mm(2000),
  buildYmm: mm(2000),
  buildZmm: mm(2000),
  marginXYmm: margin.default(3),
  marginZmm: margin.default(2),
  supportMarginXYmm: margin.default(3),
  nozzleDiameterMm: z.number().finite().min(0.1).max(2).default(0.4),
  minFeatureMm: z.number().finite().positive().max(50).nullable().optional(),
  maxSupportRatio: z.number().finite().min(0).max(1).nullable().optional(),
  allowedMaterials: z.array(materialName).max(20),
  allowedFinishes: z.array(finishName).max(20),
  notes: z.string().trim().max(500).nullable().optional(),
}).strict().superRefine((value, ctx) => {
  // the margins must leave room to print anything at all
  if (value.marginXYmm * 2 + value.supportMarginXYmm * 2 >= Math.min(value.buildXmm, value.buildYmm)) {
    ctx.addIssue({ code: 'custom', path: ['marginXYmm'], message: 'the margins leave no room on the plate' })
  }
  if (value.marginZmm >= value.buildZmm) ctx.addIssue({ code: 'custom', path: ['marginZmm'], message: 'the margin leaves no room in height' })
})

export type MachineInput = z.infer<typeof machineInputSchema>
