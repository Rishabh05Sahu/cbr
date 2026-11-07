// Properties module (Phase 5): FR-140 property inventory and FR-142 confidential owner contacts
// (ADR-0021; migration 0025). Every function authorises first, then reads and writes inside
// withTenant(), so RLS limits rows to the caller's org; the database also enforces the role
// matrix (RESTRICTIVE role policies). Permissions (user-personas-and-roles §4.5):
//   property.read                Owner, Admin, Sales Manager, Sales Executive (all properties)
//   property.manage              Owner, Admin (SM / SE are "cfg", off: no setting exists)
//   property.read_owner_contact  Owner, Admin, Sales Manager (SE "cfg", off)
// Owner contacts are never part of a property read: they are returned only by revealContacts,
// which writes an audit entry each time (domain model: "every read via UI reveal"). Properties
// are never deleted (WITHDRAWN takes one off the market); contacts are removed, never edited.
import { z } from 'zod';
import { writeAudit } from '@/modules/audit';
import { normaliseIndianPhone } from '@/modules/leads/normalise';
import { authorize, type RequestContext } from '@/platform/authz';
import { tenantRunner, type Prisma, type Tx } from '@/platform/db';
import { conflict, DomainError, notFound } from '@/platform/errors';
import {
  CONTACT_RELATIONSHIPS,
  FACINGS,
  FURNISHINGS,
  LISTING_TYPES,
  listingProblems,
  MAX_AMENITIES,
  nextPropertyCode,
  parseAmenities,
  parseAmount,
  PRICE_TYPES,
  PROPERTY_KINDS,
  PROPERTY_STATUSES,
  type ListingType,
  type PriceType,
  type PropertyStatus,
} from './rules';

export * from './rules';

const invalid = (fieldErrors: Record<string, string[]>) =>
  new DomainError('VALIDATION_FAILED', 'Please check the highlighted fields', fieldErrors);

const line = (max: number) =>
  z
    .string()
    .transform((s) =>
      s
        .replace(/[\u0000-\u001F\u007F]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .pipe(z.string().max(max, `At most ${max} characters`));
const opt = (s: z.ZodType<string>) => s.optional();

const propertyInput = z.object({
  title: line(200).refine((t) => t.length > 0, { message: 'Give the property a title' }),
  listingType: z.enum(LISTING_TYPES, 'Choose sale, rent or lease'),
  propertyType: z.enum(PROPERTY_KINDS, 'Choose a property type'),
  bhk: opt(z.string().max(3)),
  city: line(100).refine((t) => t.length > 0, { message: 'Enter the city' }),
  locality: opt(line(100)),
  addressLine: opt(line(300)),
  latitude: opt(z.string().max(20)),
  longitude: opt(z.string().max(20)),
  price: z.string().max(30),
  priceType: z.enum(PRICE_TYPES, 'Choose how the price is given'),
  maintenance: opt(z.string().max(30)),
  deposit: opt(z.string().max(30)),
  carpetAreaSqft: opt(z.string().max(20)),
  builtUpAreaSqft: opt(z.string().max(20)),
  floor: opt(line(20)),
  facing: z.enum(FACINGS).or(z.literal('')).optional(),
  furnishing: z.enum(FURNISHINGS).or(z.literal('')).optional(),
  amenities: opt(z.string().max(3000)),
  status: z.enum(PROPERTY_STATUSES).optional(),
  responsibleUserId: opt(z.string().max(40)),
  availableFrom: opt(z.string().max(10)),
  description: opt(z.string().max(5000)),
});
const updateInput = propertyInput.extend({ version: z.coerce.number().int().positive() });
const contactInput = z.object({
  name: line(120).refine((t) => t.length > 0, { message: 'Enter a name' }),
  phone: opt(z.string().max(30)),
  email: opt(z.string().max(254)),
  relationship: z.enum(CONTACT_RELATIONSHIPS, 'Choose the relationship'),
});

type PropertyInput = z.infer<typeof propertyInput>;

/** Validated column values of a property (amounts as decimal strings). */
async function columns(tx: Tx, ctx: RequestContext & { kind: 'member' }, input: PropertyInput) {
  const errors: Record<string, string[]> = {};
  const amount = (key: string, raw: string | undefined, required = false, intDigits = 13) => {
    const v = parseAmount(raw, intDigits);
    if (v === undefined) errors[key] = ['Enter an amount in rupees (up to 2 decimals)'];
    else if (v === null && required) errors[key] = ['Enter the price'];
    else if (v !== null && required && Number(v) <= 0) errors[key] = ['The price must be above 0'];
    return v ?? null;
  };
  const price = amount('price', input.price, true);
  const maintenance = amount('maintenance', input.maintenance);
  const deposit = amount('deposit', input.deposit);
  const carpet = amount('carpetAreaSqft', input.carpetAreaSqft, false, 8);
  const builtUp = amount('builtUpAreaSqft', input.builtUpAreaSqft, false, 8);
  for (const [k, v] of [
    ['carpetAreaSqft', carpet],
    ['builtUpAreaSqft', builtUp],
  ] as const)
    if (v !== null && Number(v) <= 0) errors[k] = ['The area must be above 0'];
  let bhk: number | null = null;
  if (input.bhk) {
    bhk = Number(input.bhk);
    if (!Number.isInteger(bhk) || bhk < 0 || bhk > 20) errors.bhk = ['Enter 0 to 20 bedrooms'];
  }
  let latitude: string | null = null;
  let longitude: string | null = null;
  if (input.latitude || input.longitude) {
    const la = Number(input.latitude);
    const lo = Number(input.longitude);
    if (!input.latitude || !input.longitude || !(Math.abs(la) <= 90) || !(Math.abs(lo) <= 180))
      errors.latitude = ['Enter both latitude (−90 to 90) and longitude (−180 to 180), or neither'];
    else [latitude, longitude] = [la.toFixed(6), lo.toFixed(6)];
  }
  const amenities = parseAmenities(input.amenities);
  if (amenities.length > MAX_AMENITIES) errors.amenities = [`At most ${MAX_AMENITIES} amenities`];
  if (amenities.some((a) => a.length > 50))
    errors.amenities = ['Each amenity at most 50 characters'];
  let availableFrom: Date | null = null;
  if (input.availableFrom) {
    const d = /^\d{4}-\d{2}-\d{2}$/.test(input.availableFrom)
      ? new Date(`${input.availableFrom}T00:00:00Z`)
      : null;
    if (!d || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== input.availableFrom)
      errors.availableFrom = ['Enter a valid date'];
    else availableFrom = d;
  }
  const status: PropertyStatus = input.status ?? 'DRAFT';
  Object.assign(
    errors,
    listingProblems({
      listingType: input.listingType as ListingType,
      priceType: input.priceType as PriceType,
      status,
      deposit,
    }),
  );
  // The responsible agent: an active member who can read properties (sales roles, Owner, Admin).
  let responsibleUserId = ctx.userId;
  if (input.responsibleUserId && input.responsibleUserId !== ctx.userId) {
    const id = z.uuid().safeParse(input.responsibleUserId);
    const m = id.success
      ? await tx.member.findFirst({
          where: {
            userId: id.data,
            status: 'ACTIVE',
            role: { in: ['owner', 'admin', 'sales_manager', 'sales_executive'] },
          },
          select: { userId: true },
        })
      : null;
    if (!m) errors.responsibleUserId = ['Choose an active sales member or administrator'];
    else responsibleUserId = m.userId;
  }
  const description = input.description?.replace(/\u0000/g, '').trim() || null;
  if (Object.keys(errors).length) throw invalid(errors);
  return {
    title: input.title,
    listingType: input.listingType,
    propertyType: input.propertyType,
    bhk,
    city: input.city,
    locality: input.locality || null,
    addressLine: input.addressLine || null,
    latitude,
    longitude,
    price: price!,
    priceType: input.priceType,
    maintenance,
    deposit,
    carpetAreaSqft: carpet,
    builtUpAreaSqft: builtUp,
    floor: input.floor || null,
    facing: input.facing || null,
    furnishing: input.furnishing || null,
    amenities,
    status,
    responsibleUserId,
    availableFrom,
    description,
  };
}

/** FR-140: a new property (Owner/Admin). The org-unique code is assigned in sequence. */
export async function createProperty(
  ctx: RequestContext,
  raw: unknown,
): Promise<{ id: string; code: string }> {
  authorize(ctx, 'property.manage');
  if (ctx.kind !== 'member') throw notFound('Property not found');
  const input = propertyInput.parse(raw);
  return tenantRunner().withTenant(ctx.tenant, async (tx) => {
    const data = await columns(tx, ctx, input);
    // One code at a time per org (transaction-scoped lock), then the next number.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'property_code:' + ctx.orgId}))`;
    const [row] = await tx.$queryRaw<{ n: number | null }[]>`
      SELECT max(substring(code FROM 3)::int) AS n FROM property`;
    const code = nextPropertyCode(row?.n ?? null);
    const p = await tx.property.create({
      data: { ...data, orgId: ctx.orgId, code, createdBy: ctx.userId },
      select: { id: true, code: true },
    });
    await writeAudit(tx, ctx.orgId, {
      action: 'property.created',
      entityType: 'property',
      entityId: p.id,
      actorUserId: ctx.userId,
      metadata: { code, status: data.status, listingType: data.listingType, price: data.price },
    });
    return p;
  });
}

/** Fields whose change the audit names (no contact data lives on a property). */
const TRACKED = [
  'title',
  'listingType',
  'propertyType',
  'bhk',
  'city',
  'locality',
  'addressLine',
  'latitude',
  'longitude',
  'price',
  'priceType',
  'maintenance',
  'deposit',
  'carpetAreaSqft',
  'builtUpAreaSqft',
  'floor',
  'facing',
  'furnishing',
  'amenities',
  'status',
  'responsibleUserId',
  'availableFrom',
  'description',
] as const;
const comparable = (v: unknown) =>
  v === null || v === undefined
    ? null
    : v instanceof Date
      ? v.toISOString().slice(0, 10)
      : Array.isArray(v)
        ? v.join('\u0001')
        : typeof v === 'object'
          ? String(v) // Prisma Decimal
          : String(v);
const sameNumber = (a: string | null, b: string | null) =>
  a === b || (a !== null && b !== null && Number(a) === Number(b));

/** FR-140: edits a property (Owner/Admin), optimistic-locked; status and price changes audited. */
export async function updateProperty(ctx: RequestContext, id: string, raw: unknown): Promise<void> {
  authorize(ctx, 'property.manage');
  if (ctx.kind !== 'member') throw notFound('Property not found');
  const input = updateInput.parse(raw);
  const propertyId = parseId(id);
  await tenantRunner().withTenant(ctx.tenant, async (tx) => {
    await tx.$queryRaw`SELECT id FROM property WHERE id = ${propertyId}::uuid FOR UPDATE`;
    const before = await tx.property.findFirst({ where: { id: propertyId } });
    if (!before) throw notFound('Property not found');
    if (before.version !== input.version)
      throw conflict('This property was changed by someone else. Reload the page and try again.');
    const data = await columns(tx, ctx, {
      ...input,
      // Keep the current agent and status when the form leaves them out (not "me" / Draft).
      responsibleUserId: input.responsibleUserId || before.responsibleUserId,
      status: input.status ?? (before.status as PropertyStatus),
    });
    const changed = TRACKED.filter((k) => {
      const a = comparable(before[k]);
      const b = comparable(data[k]);
      return [
        'price',
        'maintenance',
        'deposit',
        'carpetAreaSqft',
        'builtUpAreaSqft',
        'latitude',
        'longitude',
      ].includes(k)
        ? !sameNumber(a, b)
        : a !== b;
    });
    if (!changed.length) return;
    await tx.property.update({
      where: { id: propertyId },
      data: { ...data, version: { increment: 1 }, updatedAt: new Date() },
    });
    await writeAudit(tx, ctx.orgId, {
      action: 'property.updated',
      entityType: 'property',
      entityId: propertyId,
      actorUserId: ctx.userId,
      metadata: {
        changed: changed.join(','),
        ...(changed.includes('status') ? { fromStatus: before.status, toStatus: data.status } : {}),
        ...(changed.includes('price')
          ? { fromPrice: String(before.price), toPrice: data.price }
          : {}),
      },
    });
  });
}

function parseId(id: unknown): string {
  const r = z.uuid().safeParse(id);
  if (!r.success) throw notFound('Property not found');
  return r.data;
}

const PROPERTY_SELECT = {
  id: true,
  code: true,
  title: true,
  listingType: true,
  propertyType: true,
  bhk: true,
  city: true,
  locality: true,
  addressLine: true,
  latitude: true,
  longitude: true,
  price: true,
  priceType: true,
  maintenance: true,
  deposit: true,
  carpetAreaSqft: true,
  builtUpAreaSqft: true,
  floor: true,
  facing: true,
  furnishing: true,
  amenities: true,
  status: true,
  responsibleUserId: true,
  availableFrom: true,
  description: true,
  version: true,
  updatedAt: true,
  responsible: { select: { user: { select: { name: true } } } },
} satisfies Prisma.PropertySelect;

export interface PropertyView {
  id: string;
  code: string;
  title: string;
  listingType: ListingType;
  propertyType: string;
  bhk: number | null;
  city: string;
  locality: string | null;
  addressLine: string | null;
  latitude: string | null;
  longitude: string | null;
  price: string;
  priceType: PriceType;
  maintenance: string | null;
  deposit: string | null;
  carpetAreaSqft: string | null;
  builtUpAreaSqft: string | null;
  floor: string | null;
  facing: string | null;
  furnishing: string | null;
  amenities: string[];
  status: PropertyStatus;
  responsibleUserId: string;
  responsibleName: string;
  /** YYYY-MM-DD */
  availableFrom: string | null;
  description: string | null;
  version: number;
  updatedAt: Date;
}

const dec = (v: Prisma.Decimal | null) => (v === null ? null : v.toString());
function toView(p: Prisma.PropertyGetPayload<{ select: typeof PROPERTY_SELECT }>): PropertyView {
  return {
    ...p,
    listingType: p.listingType as ListingType,
    priceType: p.priceType as PriceType,
    status: p.status as PropertyStatus,
    latitude: dec(p.latitude),
    longitude: dec(p.longitude),
    price: p.price.toString(),
    maintenance: dec(p.maintenance),
    deposit: dec(p.deposit),
    carpetAreaSqft: dec(p.carpetAreaSqft),
    builtUpAreaSqft: dec(p.builtUpAreaSqft),
    availableFrom: p.availableFrom ? p.availableFrom.toISOString().slice(0, 10) : null,
    responsibleName: p.responsible.user.name,
  };
}

/** FR-140: one property (non-confidential fields; no contacts). Needs property.read. */
export async function getProperty(ctx: RequestContext, id: string): Promise<PropertyView> {
  authorize(ctx, 'property.read');
  const propertyId = parseId(id);
  return tenantRunner().withTenant(ctx.tenant, async (tx) => {
    const p = await tx.property.findFirst({ where: { id: propertyId }, select: PROPERTY_SELECT });
    if (!p) throw notFound('Property not found');
    return toView(p);
  });
}

export const PROPERTY_PAGE = 50;

const listQuery = z.object({
  q: z.string().max(100).optional(),
  status: z.enum(PROPERTY_STATUSES).optional(),
  listingType: z.enum(LISTING_TYPES).optional(),
  propertyType: z.enum(PROPERTY_KINDS).optional(),
  city: z.string().max(100).optional(),
  minPrice: z.string().max(30).optional(),
  maxPrice: z.string().max(30).optional(),
  bhk: z.string().max(3).optional(),
  page: z.string().max(5).optional(),
});
export type PropertyQuery = z.infer<typeof listQuery>;

/**
 * FR-140 inventory list: filters (status, listing type, property type, city, price range,
 * bedrooms) and a search over code, title and locality; newest first, PROPERTY_PAGE per page.
 * Invalid filter values are ignored (the page shows the rest). Needs property.read.
 */
export async function listProperties(
  ctx: RequestContext,
  raw: Record<string, string | undefined>,
): Promise<{ rows: PropertyView[]; page: number; hasMore: boolean; query: PropertyQuery }> {
  authorize(ctx, 'property.read');
  const parsed = listQuery.safeParse(raw);
  const q: PropertyQuery = parsed.success ? parsed.data : {};
  const and: Prisma.PropertyWhereInput[] = [];
  if (q.status) and.push({ status: q.status });
  if (q.listingType) and.push({ listingType: q.listingType });
  if (q.propertyType) and.push({ propertyType: q.propertyType });
  if (q.city?.trim()) and.push({ city: { equals: q.city.trim(), mode: 'insensitive' } });
  const min = parseAmount(q.minPrice);
  const max = parseAmount(q.maxPrice);
  if (min) and.push({ price: { gte: min } });
  if (max) and.push({ price: { lte: max } });
  if (q.bhk && /^\d{1,2}$/.test(q.bhk)) and.push({ bhk: Number(q.bhk) });
  const term = q.q?.replace(/\s+/g, ' ').trim();
  if (term)
    and.push({
      OR: [
        { code: { contains: term, mode: 'insensitive' } },
        { title: { contains: term, mode: 'insensitive' } },
        { locality: { contains: term, mode: 'insensitive' } },
      ],
    });
  const page = Math.min(Math.max(Number(q.page) || 1, 1), 1000);
  return tenantRunner().withTenant(ctx.tenant, async (tx) => {
    const rows = await tx.property.findMany({
      where: { AND: and },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * PROPERTY_PAGE,
      take: PROPERTY_PAGE + 1,
      select: PROPERTY_SELECT,
    });
    return {
      rows: rows.slice(0, PROPERTY_PAGE).map(toView),
      page,
      hasMore: rows.length > PROPERTY_PAGE,
      query: q,
    };
  });
}

/** People who may be a property's responsible agent (active Owner, Admin and sales members). */
export async function responsibleOptions(
  ctx: RequestContext,
): Promise<{ userId: string; name: string }[]> {
  authorize(ctx, 'property.manage');
  return tenantRunner().withTenant(ctx.tenant, async (tx) =>
    (
      await tx.member.findMany({
        where: {
          status: 'ACTIVE',
          role: { in: ['owner', 'admin', 'sales_manager', 'sales_executive'] },
        },
        orderBy: [{ user: { name: 'asc' } }, { userId: 'asc' }],
        take: 500,
        select: { userId: true, user: { select: { name: true } } },
      })
    ).map((m) => ({ userId: m.userId, name: m.user.name })),
  );
}

// ---------------------------------------------------------------------------------------------
// FR-142 owner contacts

export interface PropertyContactView {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  relationship: string;
}

/**
 * FR-142: the current contacts of a property, for a caller with property.read_owner_contact.
 * Every call writes an audit entry (who saw which property's contacts, how many; no contact data).
 */
export async function revealContacts(
  ctx: RequestContext,
  propertyId: string,
): Promise<PropertyContactView[]> {
  authorize(ctx, 'property.read_owner_contact');
  const id = parseId(propertyId);
  return tenantRunner().withTenant(ctx.tenant, async (tx) => {
    const p = await tx.property.findFirst({ where: { id }, select: { id: true } });
    if (!p) throw notFound('Property not found');
    const rows = await tx.propertyContact.findMany({
      where: { propertyId: id, removedAt: null },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, name: true, phoneE164: true, email: true, relationship: true },
    });
    await writeAudit(tx, ctx.orgId, {
      action: 'property.contacts_viewed',
      entityType: 'property',
      entityId: id,
      actorUserId: ctx.userId,
      metadata: { count: rows.length },
    });
    return rows.map((r) => ({ ...r, phone: r.phoneE164 }));
  });
}

/** FR-142: adds a contact (Owner/Admin). Phone (Indian mobile) or email required. */
export async function addContact(
  ctx: RequestContext,
  propertyId: string,
  raw: unknown,
): Promise<{ id: string }> {
  authorize(ctx, 'property.manage');
  if (ctx.kind !== 'member') throw notFound('Property not found');
  const input = contactInput.parse(raw);
  const id = parseId(propertyId);
  const errors: Record<string, string[]> = {};
  const phone = normaliseIndianPhone(input.phone);
  if (!phone.ok) errors.phone = [phone.message];
  const email = input.email?.trim().toLowerCase() || null;
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) errors.email = ['Enter a valid email'];
  const phoneE164 = phone.ok ? (phone.value?.e164 ?? null) : null;
  if (!errors.phone && !errors.email && !phoneE164 && !email)
    errors.phone = ['Enter a phone number or an email'];
  if (Object.keys(errors).length) throw invalid(errors);
  return tenantRunner().withTenant(ctx.tenant, async (tx) => {
    const p = await tx.property.findFirst({ where: { id }, select: { id: true } });
    if (!p) throw notFound('Property not found');
    const c = await tx.propertyContact.create({
      data: {
        orgId: ctx.orgId,
        propertyId: id,
        name: input.name,
        phoneE164,
        email,
        relationship: input.relationship,
        createdBy: ctx.userId,
      },
      select: { id: true },
    });
    await writeAudit(tx, ctx.orgId, {
      action: 'property.contact_added',
      entityType: 'property',
      entityId: id,
      actorUserId: ctx.userId,
      metadata: { contactId: c.id, relationship: input.relationship },
    });
    return c;
  });
}

/** FR-142: removes a contact (recorded, never deleted). Owner/Admin. */
export async function removeContact(ctx: RequestContext, contactId: string): Promise<void> {
  authorize(ctx, 'property.manage');
  if (ctx.kind !== 'member') throw notFound('Contact not found');
  const r = z.uuid().safeParse(contactId);
  if (!r.success) throw notFound('Contact not found');
  await tenantRunner().withTenant(ctx.tenant, async (tx) => {
    // now() in SQL: the RESTRICTIVE update policy requires the transaction time exactly.
    const rows = await tx.$queryRaw<{ property_id: string }[]>`
      UPDATE property_contact SET removed_at = now(), removed_by = ${ctx.userId}::uuid
       WHERE id = ${r.data}::uuid AND removed_at IS NULL
      RETURNING property_id`;
    if (!rows.length) throw notFound('Contact not found');
    await writeAudit(tx, ctx.orgId, {
      action: 'property.contact_removed',
      entityType: 'property',
      entityId: rows[0]!.property_id,
      actorUserId: ctx.userId,
      metadata: { contactId: r.data },
    });
  });
}
