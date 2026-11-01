import type { Context } from 'hono'
import { Hono } from 'hono'

type Bindings = { DB: D1Database }
type HomeRow = { id: string; name: string }
type MemberRow = { id: number; home_id: string; name: string }
type BillRow = { id: string; home_id: string; title: string; total_cents: number }
type ShareRow = { id: string; member_id: number; amount_cents: number; paid_at: string | null }
type PaymentRow = { idempotency_key: string; paid_at: string }

type HomeRequest = { name: string }
type BillRequest = { title: string; totalCents: number }
type ShareResponse = { id: string; memberId: string; amountCents: number; paidAt: string | null }
type MemberResponse = { id: string; homeId: string; name: string }

const app = new Hono<{ Bindings: Bindings }>()

function error(
  c: Context<{ Bindings: Bindings }>,
  status: 400 | 404 | 409 | 422 | 500,
  message: string,
) {
  return c.json({ error: message }, status)
}

async function jsonBody<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T
  } catch {
    return null
  }
}

function validName(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function routeId(value: string | undefined): string | null {
  return value && value.trim().length > 0 ? value : null
}

function shareResponse(row: ShareRow): ShareResponse {
  return {
    id: row.id,
    memberId: String(row.member_id),
    amountCents: row.amount_cents,
    paidAt: row.paid_at,
  }
}

app.get('/api/health', (c) => c.json({ status: 'ok' }))

app.post('/api/homes', async (c) => {
  const body = await jsonBody<HomeRequest>(c.req.raw)
  if (!body || !validName(body.name)) return error(c, 422, 'name must be a non-empty string')

  const home = { id: crypto.randomUUID(), name: body.name.trim() }
  await c.env.DB.prepare('INSERT INTO homes (id, name) VALUES (?, ?)')
    .bind(home.id, home.name)
    .run()
  return c.json(home, 201)
})

app.post('/api/homes/:homeId/members', async (c) => {
  const homeId = routeId(c.req.param('homeId'))
  const body = await jsonBody<HomeRequest>(c.req.raw)
  if (!homeId) return error(c, 404, 'home not found')
  if (!body || !validName(body.name)) return error(c, 422, 'name must be a non-empty string')

  const home = await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?')
    .bind(homeId)
    .first<HomeRow>()
  if (!home) return error(c, 404, 'home not found')

  const result = await c.env.DB.prepare(
    'INSERT INTO members (home_id, name) VALUES (?, ?) RETURNING id',
  )
    .bind(homeId, body.name.trim())
    .first<{ id: number }>()
  if (!result) return error(c, 500, 'could not create member')
  const member: MemberResponse = { id: String(result.id), homeId, name: body.name.trim() }
  return c.json(member, 201)
})

app.post('/api/homes/:homeId/bills', async (c) => {
  const homeId = routeId(c.req.param('homeId'))
  const body = await jsonBody<BillRequest>(c.req.raw)
  if (!homeId) return error(c, 404, 'home not found')
  if (
    !body ||
    !validName(body.title) ||
    !Number.isSafeInteger(body.totalCents) ||
    body.totalCents <= 0
  ) {
    return error(c, 422, 'title must be non-empty and totalCents must be a positive whole number')
  }

  const home = await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?')
    .bind(homeId)
    .first<HomeRow>()
  if (!home) return error(c, 404, 'home not found')
  const members = await c.env.DB.prepare(
    'SELECT id, home_id, name FROM members WHERE home_id = ? ORDER BY id',
  )
    .bind(homeId)
    .all<MemberRow>()
  if (members.results.length === 0) return error(c, 422, 'home must have at least one member')

  const billId = crypto.randomUUID()
  const base = Math.floor(body.totalCents / members.results.length)
  const remainder = body.totalCents % members.results.length
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(
      'INSERT INTO bills (id, home_id, title, total_cents) VALUES (?, ?, ?, ?)',
    ).bind(billId, homeId, body.title.trim(), body.totalCents),
  ]
  const shares: ShareResponse[] = []
  for (const [index, member] of members.results.entries()) {
    const share = {
      id: crypto.randomUUID(),
      memberId: String(member.id),
      amountCents: base + (index < remainder ? 1 : 0),
      paidAt: null,
    }
    shares.push(share)
    statements.push(
      c.env.DB.prepare(
        'INSERT INTO shares (id, bill_id, member_id, amount_cents) VALUES (?, ?, ?, ?)',
      ).bind(share.id, billId, member.id, share.amountCents),
    )
  }
  await c.env.DB.batch(statements)
  return c.json(
    { id: billId, homeId, title: body.title.trim(), totalCents: body.totalCents, shares },
    201,
  )
})

app.get('/api/homes/:homeId/bills', async (c) => {
  const homeId = routeId(c.req.param('homeId'))
  if (!homeId) return error(c, 404, 'home not found')
  const home = await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?')
    .bind(homeId)
    .first<HomeRow>()
  if (!home) return error(c, 404, 'home not found')
  const bills = await c.env.DB.prepare(
    'SELECT id, home_id, title, total_cents FROM bills WHERE home_id = ? ORDER BY rowid',
  )
    .bind(homeId)
    .all<BillRow>()
  const result: Array<{
    id: string
    homeId: string
    title: string
    totalCents: number
    shares: ShareResponse[]
  }> = []
  for (const bill of bills.results) {
    const shares = await c.env.DB.prepare(
      'SELECT id, member_id, amount_cents, paid_at FROM shares WHERE bill_id = ? ORDER BY rowid',
    )
      .bind(bill.id)
      .all<ShareRow>()
    result.push({
      id: bill.id,
      homeId: bill.home_id,
      title: bill.title,
      totalCents: bill.total_cents,
      shares: shares.results.map(shareResponse),
    })
  }
  return c.json({ bills: result })
})

app.post('/api/bills/:billId/shares/:shareId/pay', async (c) => {
  const billId = routeId(c.req.param('billId'))
  const shareId = routeId(c.req.param('shareId'))
  const key = c.req.header('Idempotency-Key')?.trim()
  if (!key) return error(c, 400, 'Idempotency-Key header is required')
  if (!billId || !shareId) return error(c, 404, 'bill or share not found')

  const share = await c.env.DB.prepare(
    'SELECT s.id, s.member_id, s.amount_cents, s.paid_at FROM shares s WHERE s.id = ? AND s.bill_id = ?',
  )
    .bind(shareId, billId)
    .first<ShareRow>()
  if (!share) return error(c, 404, 'bill or share not found')

  const payment = await c.env.DB.prepare(
    'SELECT idempotency_key, paid_at FROM payments WHERE share_id = ?',
  )
    .bind(shareId)
    .first<PaymentRow>()
  if (payment) {
    if (payment.idempotency_key !== key) return error(c, 409, 'share is already paid')
    return c.json({
      ...shareResponse({ ...share, paid_at: payment.paid_at }),
      paidAt: payment.paid_at,
    })
  }

  const paidAt = new Date().toISOString()
  try {
    const results = await c.env.DB.batch([
      c.env.DB.prepare(
        'INSERT INTO payments (share_id, idempotency_key, paid_at) VALUES (?, ?, ?)',
      ).bind(shareId, key, paidAt),
      c.env.DB.prepare(
        'UPDATE shares SET paid_at = ? WHERE id = ? AND bill_id = ? AND paid_at IS NULL',
      ).bind(paidAt, shareId, billId),
    ])
    if (results[1]?.meta.changes !== 1) {
      throw new Error('share payment update did not change a row')
    }
  } catch (reason) {
    const existing = await c.env.DB.prepare(
      'SELECT idempotency_key, paid_at FROM payments WHERE share_id = ?',
    )
      .bind(shareId)
      .first<PaymentRow>()
    if (existing?.idempotency_key === key) {
      return c.json({
        ...shareResponse({ ...share, paid_at: existing.paid_at }),
        paidAt: existing.paid_at,
      })
    }
    if (!existing) throw reason
    return error(c, 409, 'share is already paid')
  }
  return c.json({ ...shareResponse({ ...share, paid_at: paidAt }), paidAt })
})

app.get('/api/homes/:homeId/balances', async (c) => {
  const homeId = routeId(c.req.param('homeId'))
  if (!homeId) return error(c, 404, 'home not found')
  const home = await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?')
    .bind(homeId)
    .first<HomeRow>()
  if (!home) return error(c, 404, 'home not found')

  const rows = await c.env.DB.prepare(
    `SELECT m.id AS member_id, m.name, COALESCE(SUM(CASE WHEN s.paid_at IS NULL THEN s.amount_cents ELSE 0 END), 0) AS outstanding_cents
     FROM members m LEFT JOIN shares s ON s.member_id = m.id
     WHERE m.home_id = ? GROUP BY m.id, m.name ORDER BY m.id`,
  )
    .bind(homeId)
    .all<{ member_id: string; name: string; outstanding_cents: number }>()
  return c.json({
    balances: rows.results.map((row) => ({
      memberId: String(row.member_id),
      name: row.name,
      outstandingCents: row.outstanding_cents,
    })),
  })
})

app.notFound((c) => c.json({ error: 'not found' }, 404))
app.onError((err, c) => {
  console.error(err)
  return c.json({ error: 'internal server error' }, 500)
})

export default app
