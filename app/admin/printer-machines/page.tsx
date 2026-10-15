export const dynamic = 'force-dynamic'

import { prisma } from '@/lib/db'
import { MATERIAL_OPTIONS } from '@/lib/cartPricing'
import { knownFinishes } from '@/lib/pricing'
import PrinterMachinesManager from '@/components/admin/PrinterMachinesManager'

export default async function AdminPrinterMachinesPage() {
  const machines = await prisma.printerMachine.findMany({ orderBy: [{ isActive: 'desc' }, { createdAt: 'asc' }] })
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold">Printer machines</h1>
        <p className="mt-1 text-sm text-slate-400">
          What each machine can make. An order line is paid online only if at least one ACTIVE machine can make it (material, finish and size);
          everything else goes to manual review. To add another machine, add it here: no code change is needed.
        </p>
      </div>
      <PrinterMachinesManager
        initial={JSON.parse(JSON.stringify(machines))}
        materials={[...MATERIAL_OPTIONS]}
        finishes={knownFinishes()}
      />
    </div>
  )
}
