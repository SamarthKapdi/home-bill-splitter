import { createFileRoute } from '@tanstack/react-router'
import { useRef, useState } from 'react'

export const Route = createFileRoute('/')({
  component: Home,
})

function Home() {
  const [homeId, setHomeId] = useState('')
  const [bills, setBills] = useState<Bill[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const paymentKeys = useRef(new Map<string, string>())

  async function loadBills() {
    const id = homeId.trim()
    if (!id) {
      setError('Enter a home ID.')
      return
    }
    setLoading(true)
    setError(null)
    try {
      const response = await fetchWithTimeout(`/api/homes/${encodeURIComponent(id)}/bills`)
      const payload = await readResponse(response)
      if (!response.ok) throw new Error(payload.error ?? 'Could not load bills.')
      setBills(payload.bills ?? [])
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not load bills.')
      setBills([])
    } finally {
      setLoading(false)
    }
  }

  async function pay(shareId: string, billId: string) {
    setError(null)
    const key = paymentKeys.current.get(shareId) ?? crypto.randomUUID()
    paymentKeys.current.set(shareId, key)
    try {
      const response = await fetchWithTimeout(
        `/api/bills/${encodeURIComponent(billId)}/shares/${encodeURIComponent(shareId)}/pay`,
        {
          method: 'POST',
          headers: { 'Idempotency-Key': key },
        },
      )
      const payload = await readResponse(response)
      if (!response.ok) {
        if (response.status === 409) {
          paymentKeys.current.delete(shareId)
          await loadBills()
          return
        }
        if (response.status >= 400 && response.status < 500) {
          paymentKeys.current.delete(shareId)
        }
        throw new Error(payload.error ?? 'Could not pay share.')
      }
      paymentKeys.current.delete(shareId)
      setBills((current) =>
        current.map((bill) =>
          bill.id === billId
            ? {
                ...bill,
                shares: bill.shares.map((share) =>
                  share.id === shareId
                    ? { ...share, paidAt: payload.paidAt ?? share.paidAt }
                    : share,
                ),
              }
            : bill,
        ),
      )
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not pay share.')
    }
  }

  return (
    <main style={{ padding: 24, fontFamily: 'system-ui, sans-serif' }}>
      <h1>Bill Splitter</h1>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void loadBills()
        }}
      >
        <label>
          Home ID
          <input value={homeId} onChange={(event) => setHomeId(event.target.value)} />
        </label>
        <button type="submit" disabled={loading}>
          {loading ? 'Loading...' : 'Load bills'}
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
      {loading && <p>Loading bills...</p>}
      {!loading && !error && bills.length === 0 && <p>No bills found for this home.</p>}
      {bills.map((bill) => (
        <section key={bill.id}>
          <h2>
            {bill.title} ({bill.totalCents} cents)
          </h2>
          {bill.shares.length === 0 ? (
            <p>No shares.</p>
          ) : (
            <ul>
              {bill.shares.map((share) => (
                <li key={share.id}>
                  Member {share.memberId}: {share.amountCents} cents —{' '}
                  {share.paidAt ? 'Paid' : 'Unpaid'}
                  {!share.paidAt && (
                    <button type="button" onClick={() => void pay(share.id, bill.id)}>
                      Pay
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
    </main>
  )
}

type Share = { id: string; memberId: string; amountCents: number; paidAt: string | null }
type Bill = { id: string; homeId: string; title: string; totalCents: number; shares: Share[] }
type ApiPayload = { error?: string; paidAt?: string; bills?: Bill[] }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isShare(value: unknown): value is Share {
  if (!isRecord(value)) return false
  return (
    typeof value.id === 'string' &&
    typeof value.memberId === 'string' &&
    typeof value.amountCents === 'number' &&
    (value.paidAt === null || typeof value.paidAt === 'string')
  )
}

function isBill(value: unknown): value is Bill {
  if (!isRecord(value)) return false
  return (
    typeof value.id === 'string' &&
    typeof value.homeId === 'string' &&
    typeof value.title === 'string' &&
    typeof value.totalCents === 'number' &&
    Array.isArray(value.shares) &&
    value.shares.every(isShare)
  )
}

async function fetchWithTimeout(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10000)
  try {
    return await fetch(input, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
}

async function readResponse(response: Response): Promise<ApiPayload> {
  try {
    const value: unknown = await response.json()
    if (!isRecord(value)) return {}
    return {
      error: typeof value.error === 'string' ? value.error : undefined,
      paidAt: typeof value.paidAt === 'string' ? value.paidAt : undefined,
      bills: Array.isArray(value.bills) && value.bills.every(isBill) ? value.bills : undefined,
    }
  } catch {
    return {}
  }
}
