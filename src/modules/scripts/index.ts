// Scripts module (Phase 3 slice 5; FR-095 authoring, FR-096 targeting and match order, FR-097
// versions; migration 0014, ADR-0011). Public API per module-boundaries: createScript /
// saveDraft (createDraft) / publishScript / archiveScript, and the queries listPublishedScripts,
// getPublishedScript (getVersion), suggestForLead. The lead-page script drawer (FR-099/FR-057)
// reads suggestForLead (ADR-0011 decisions 10–11); FR-098 is not built.
//
// Every function authorises first (script.manage or script.read, user-personas-and-roles §4.2),
// then reads and writes inside withTenant(): RLS limits rows to the caller's org, and the role
// policies of 0014 repeat the matrix in the database (sales roles read published scripts only).
// Writes lock the script row (FOR UPDATE) and check its optimistic version, so concurrent edits
// and publications serialise; a refused step rolls the whole transaction back.
import { z } from 'zod';
import { writeAudit } from '@/modules/audit';
import {
  leadForTask,
  normalizeSourceName,
  PROPERTY_TYPES,
  sourceKey,
  TRANSACTION_TYPES,
} from '@/modules/leads';
import { authorize, type RequestContext } from '@/platform/authz';
import { tenantRunner, type Tx } from '@/platform/db';
import { conflict, DomainError, notFound, ruleViolation } from '@/platform/errors';
import { rankScripts, type ScriptTargeting } from './matching';
import { markupToHtml } from './rich-text';

export { matchScore, rankScripts, type LeadForMatching, type ScriptTargeting } from './matching';
export { markupToHtml, sanitizeScriptHtml, SCRIPT_HTML_ALLOWED_TAGS } from './rich-text';

export const SCRIPT_SECTIONS = ['opening', 'questions', 'pitch', 'closing'] as const;
export type ScriptSection = (typeof SCRIPT_SECTIONS)[number];
export const MAX_SECTION_CHARS = 5000;
export const MAX_OBJECTIONS = 30;
export const MAX_SCRIPTS_PER_ORG = 200;

/** One rich-text section: the author's markup and its sanitized HTML. */
export interface SectionContent {
  text: string;
  html: string;
}
export interface ScriptContent {
  opening: SectionContent;
  questions: SectionContent;
  pitch: SectionContent;
  closing: SectionContent;
  objections: { objection: string; response: SectionContent }[];
}

export type ScriptStatus = 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';

const EMPTY_SECTION: SectionContent = { text: '', html: '' };
export const EMPTY_CONTENT: ScriptContent = {
  opening: EMPTY_SECTION,
  questions: EMPTY_SECTION,
  pitch: EMPTY_SECTION,
  closing: EMPTY_SECTION,
  objections: [],
};

function invalid(fieldErrors: Record<string, string[]>): DomainError {
  return new DomainError('VALIDATION_FAILED', 'Please check the highlighted fields', fieldErrors);
}
const stale = () =>
  conflict('This script was changed by someone else. Reload the page and try again.');
const archivedError = () => ruleViolation('This script is archived and can no longer change');
const duplicate = (name: string) =>
  conflict(`A script named "${name}" already exists (names ignore case and spacing)`);

function parseScriptId(id: unknown): string {
  const r = z.uuid().safeParse(id);
  if (!r.success) throw notFound('Script not found');
  return r.data;
}

const plain = (max: number, msg: string) =>
  z
    .string()
    .transform((s) => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ''))
    .pipe(z.string().max(max, msg));

const nameSchema = z
  .string()
  .transform(normalizeSourceName)
  .pipe(z.string().min(1, 'Enter a name').max(100, 'At most 100 characters'));

const sectionText = plain(MAX_SECTION_CHARS, `At most ${MAX_SECTION_CHARS} characters`);

const draftInput = z.object({
  opening: sectionText,
  questions: sectionText,
  pitch: sectionText,
  closing: sectionText,
  objections: z
    .array(
      z.object({
        objection: plain(300, 'At most 300 characters').transform((s) =>
          s.replace(/\s+/g, ' ').trim(),
        ),
        response: sectionText,
      }),
    )
    .max(MAX_OBJECTIONS, `At most ${MAX_OBJECTIONS} objections`),
  /** The draft version the editor started from (0 when there was no draft). */
  draftVersion: z.coerce.number().int().min(0),
});

const settingsInput = z.object({
  name: nameSchema,
  transactionTypes: z.array(z.enum(TRANSACTION_TYPES)).max(TRANSACTION_TYPES.length),
  propertyTypes: z.array(z.enum(PROPERTY_TYPES)).max(PROPERTY_TYPES.length),
  /** Comma-separated two-letter language codes, e.g. "hi, mr" (as lead.preferredLanguage). */
  languages: plain(200, 'Too long'),
  sourceIds: z.array(z.uuid()).max(50),
  version: z.coerce.number().int().positive(),
});

const versionOnly = z.object({ version: z.coerce.number().int().positive() });

/** Author markup of every section → stored content (sanitized HTML alongside the markup). */
export function buildContent(
  input: Omit<z.infer<typeof draftInput>, 'draftVersion'>,
): ScriptContent {
  const section = (text: string): SectionContent => {
    const t = text.replace(/\r\n?/g, '\n').trim();
    return { text: t, html: t ? markupToHtml(t) : '' };
  };
  return {
    opening: section(input.opening),
    questions: section(input.questions),
    pitch: section(input.pitch),
    closing: section(input.closing),
    objections: input.objections
      .filter((o) => o.objection || o.response.trim())
      .map((o) => ({ objection: o.objection, response: section(o.response) })),
  };
}

/** Stored JSON → content, tolerating missing parts (content is always written by buildContent). */
export function readContent(raw: unknown): ScriptContent {
  const o = (raw ?? {}) as Partial<Record<string, unknown>>;
  const sec = (v: unknown): SectionContent => {
    const s = (v ?? {}) as Partial<SectionContent>;
    return {
      text: typeof s.text === 'string' ? s.text : '',
      html: typeof s.html === 'string' ? s.html : '',
    };
  };
  const objections = Array.isArray(o.objections) ? o.objections : [];
  return {
    opening: sec(o.opening),
    questions: sec(o.questions),
    pitch: sec(o.pitch),
    closing: sec(o.closing),
    objections: objections.map((x) => {
      const ob = (x ?? {}) as { objection?: unknown; response?: unknown };
      return {
        objection: typeof ob.objection === 'string' ? ob.objection : '',
        response: sec(ob.response),
      };
    }),
  };
}

const hasContent = (c: ScriptContent) =>
  SCRIPT_SECTIONS.some((s) => c[s].text !== '') || c.objections.length > 0;

/** Locks the script row for the rest of the transaction and returns it. */
async function lockScript(tx: Tx, id: string) {
  await tx.$queryRaw`SELECT id FROM call_script WHERE id = ${id}::uuid FOR UPDATE`;
  const script = await tx.callScript.findFirst({ where: { id } });
  if (!script) throw notFound('Script not found');
  return script;
}

async function draftOf(tx: Tx, scriptId: string) {
  return tx.callScriptVersion.findFirst({ where: { scriptId, publishedAt: null } });
}

// ---------------------------------------------------------------------------------------------
// Commands (script.manage: Owner/Admin)

export async function createScript(ctx: RequestContext, raw: unknown): Promise<{ id: string }> {
  authorize(ctx, 'script.manage');
  const { name } = z.object({ name: nameSchema }).parse(raw);
  try {
    return await tenantRunner().withTenant(ctx.tenant, async (tx) => {
      const existing = await tx.callScript.findMany({ select: { name: true } });
      if (existing.length >= MAX_SCRIPTS_PER_ORG)
        throw ruleViolation(`An organisation can have at most ${MAX_SCRIPTS_PER_ORG} scripts`);
      const clash = existing.find((s) => sourceKey(s.name) === sourceKey(name));
      if (clash) throw duplicate(clash.name);
      const script = await tx.callScript.create({
        data: { orgId: ctx.orgId, name, createdBy: ctx.userId },
        select: { id: true },
      });
      await tx.callScriptVersion.create({
        data: {
          orgId: ctx.orgId,
          scriptId: script.id,
          versionNo: 1,
          content: EMPTY_CONTENT as object,
          createdBy: ctx.userId,
        },
      });
      await writeAudit(tx, ctx.orgId, {
        action: 'script.created',
        entityType: 'call_script',
        entityId: script.id,
        actorUserId: ctx.userId,
        metadata: { name },
      });
      return script;
    });
  } catch (e) {
    if (e instanceof Error && /call_script_org_name_uq/.test(e.message)) throw duplicate(name);
    throw e;
  }
}

/** Name and targeting (script metadata; not versioned). */
export async function updateScriptSettings(
  ctx: RequestContext,
  scriptId: string,
  raw: unknown,
): Promise<void> {
  authorize(ctx, 'script.manage');
  const id = parseScriptId(scriptId);
  const input = settingsInput.parse(raw);
  const languages = [
    ...new Set(
      input.languages
        .split(',')
        .map((l) => l.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  if (languages.length > 20 || languages.some((l) => !/^[a-z]{2}$/.test(l)))
    throw invalid({ languages: ['Use two-letter language codes, e.g. hi, mr (at most 20)'] });
  try {
    await tenantRunner().withTenant(ctx.tenant, async (tx) => {
      const script = await lockScript(tx, id);
      if (script.status === 'ARCHIVED') throw archivedError();
      if (script.version !== input.version) throw stale();
      const sourceIds = [...new Set(input.sourceIds.map((s) => s.toLowerCase()))];
      if (sourceIds.length) {
        const found = await tx.leadSource.count({ where: { id: { in: sourceIds } } });
        if (found !== sourceIds.length) throw invalid({ sourceIds: ['Unknown lead source'] });
      }
      const others = await tx.callScript.findMany({
        where: { id: { not: id } },
        select: { name: true },
      });
      const clash = others.find((s) => sourceKey(s.name) === sourceKey(input.name));
      if (clash) throw duplicate(clash.name);
      await tx.callScript.update({
        where: { id },
        data: {
          name: input.name,
          transactionTypes: [...new Set(input.transactionTypes)],
          propertyTypes: [...new Set(input.propertyTypes)],
          languages,
          sourceIds,
          version: { increment: 1 },
          updatedAt: new Date(),
        },
      });
      await writeAudit(tx, ctx.orgId, {
        action: 'script.updated',
        entityType: 'call_script',
        entityId: id,
        actorUserId: ctx.userId,
        metadata: {
          name: input.name,
          transactionTypes: input.transactionTypes.join(','),
          propertyTypes: input.propertyTypes.join(','),
          languages: languages.join(','),
          sources: sourceIds.length,
        },
      });
    });
  } catch (e) {
    if (e instanceof Error && /call_script_org_name_uq/.test(e.message))
      throw duplicate(input.name);
    throw e;
  }
}

/**
 * Saves the draft content (FR-095). Editing a published script creates the next draft version
 * (FR-097); the published version is never touched. `draftVersion` is the draft's version the
 * editor started from (0 when there was none), so a concurrent edit or publication is refused.
 */
export async function saveDraft(
  ctx: RequestContext,
  scriptId: string,
  raw: unknown,
): Promise<{ versionNo: number }> {
  authorize(ctx, 'script.manage');
  const id = parseScriptId(scriptId);
  const { draftVersion, ...sections } = draftInput.parse(raw);
  const content = buildContent(sections);
  return tenantRunner().withTenant(ctx.tenant, async (tx) => {
    const script = await lockScript(tx, id);
    if (script.status === 'ARCHIVED') throw archivedError();
    const draft = await draftOf(tx, id);
    let versionNo: number;
    if (draft) {
      if (draft.version !== draftVersion) throw stale();
      await tx.callScriptVersion.update({
        where: { id: draft.id },
        data: { content: content as object, version: { increment: 1 }, updatedAt: new Date() },
      });
      versionNo = draft.versionNo;
    } else {
      if (draftVersion !== 0) throw stale(); // the draft the editor saw was published meanwhile
      const last = await tx.callScriptVersion.aggregate({
        where: { scriptId: id },
        _max: { versionNo: true },
      });
      versionNo = (last._max.versionNo ?? 0) + 1;
      await tx.callScriptVersion.create({
        data: {
          orgId: ctx.orgId,
          scriptId: id,
          versionNo,
          content: content as object,
          createdBy: ctx.userId,
        },
      });
    }
    await writeAudit(tx, ctx.orgId, {
      action: 'script.draft_saved',
      entityType: 'call_script',
      entityId: id,
      actorUserId: ctx.userId,
      metadata: { versionNo },
    });
    return { versionNo };
  });
}

/**
 * Publishes the current draft (FR-097): the draft becomes an immutable version and the script's
 * live version, in one transaction. The draft the publisher saw must still be the draft.
 */
export async function publishScript(
  ctx: RequestContext,
  scriptId: string,
  raw: unknown,
): Promise<{ versionNo: number }> {
  authorize(ctx, 'script.manage');
  const id = parseScriptId(scriptId);
  const { draftVersion } = z
    .object({ draftVersion: z.coerce.number().int().positive() })
    .parse(raw);
  return tenantRunner().withTenant(ctx.tenant, async (tx) => {
    const script = await lockScript(tx, id);
    if (script.status === 'ARCHIVED') throw archivedError();
    const draft = await draftOf(tx, id);
    if (!draft) throw ruleViolation('There is no draft to publish. Edit the script first');
    if (draft.version !== draftVersion) throw stale();
    if (!hasContent(readContent(draft.content)))
      throw ruleViolation('Add content to at least one section before publishing');
    await tx.$executeRaw`
      UPDATE call_script_version
         SET published_at = now(), published_by = ${ctx.userId}::uuid,
             version = version + 1, updated_at = now()
       WHERE id = ${draft.id}::uuid`;
    await tx.$executeRaw`
      UPDATE call_script
         SET status = 'PUBLISHED', current_version_id = ${draft.id}::uuid,
             version = version + 1, updated_at = now()
       WHERE id = ${id}::uuid`;
    await writeAudit(tx, ctx.orgId, {
      action: 'script.published',
      entityType: 'call_script',
      entityId: id,
      actorUserId: ctx.userId,
      metadata: { versionNo: draft.versionNo },
    });
    return { versionNo: draft.versionNo };
  });
}

/** Archives a script (final). The script and every version are kept; nothing is deleted. */
export async function archiveScript(
  ctx: RequestContext,
  scriptId: string,
  raw: unknown,
): Promise<void> {
  authorize(ctx, 'script.manage');
  const id = parseScriptId(scriptId);
  const { version } = versionOnly.parse(raw);
  await tenantRunner().withTenant(ctx.tenant, async (tx) => {
    const script = await lockScript(tx, id);
    if (script.status === 'ARCHIVED') throw archivedError();
    if (script.version !== version) throw stale();
    await tx.$executeRaw`
      UPDATE call_script
         SET status = 'ARCHIVED', archived_at = now(), version = version + 1, updated_at = now()
       WHERE id = ${id}::uuid`;
    await writeAudit(tx, ctx.orgId, {
      action: 'script.archived',
      entityType: 'call_script',
      entityId: id,
      actorUserId: ctx.userId,
      metadata: { name: script.name },
    });
  });
}

// ---------------------------------------------------------------------------------------------
// Queries

export interface ScriptSummary extends ScriptTargeting {
  id: string;
  name: string;
  status: ScriptStatus;
  liveVersionNo: number | null;
  hasDraft: boolean;
  updatedAt: Date;
}

/** Every script of the org, for authors (script.manage). Live first, then drafts, then archived. */
export async function listScriptsForManage(ctx: RequestContext): Promise<ScriptSummary[]> {
  authorize(ctx, 'script.manage');
  return tenantRunner().withTenant(ctx.tenant, async (tx) => {
    const rows = await tx.callScript.findMany({
      include: {
        currentVersion: { select: { versionNo: true } },
        versions: { where: { publishedAt: null }, select: { id: true } },
      },
    });
    const rank: Record<string, number> = { PUBLISHED: 0, DRAFT: 1, ARCHIVED: 2 };
    return rows
      .map((s) => ({
        id: s.id,
        name: s.name,
        status: s.status as ScriptStatus,
        liveVersionNo: s.currentVersion?.versionNo ?? null,
        hasDraft: s.versions.length > 0 && s.status !== 'ARCHIVED',
        updatedAt: s.updatedAt,
        transactionTypes: s.transactionTypes,
        propertyTypes: s.propertyTypes,
        languages: s.languages,
        sourceIds: s.sourceIds,
      }))
      .sort(
        (a, b) =>
          (rank[a.status] ?? 9) - (rank[b.status] ?? 9) ||
          a.name.toLowerCase().localeCompare(b.name.toLowerCase(), 'en') ||
          (a.id < b.id ? -1 : 1),
      );
  });
}

export interface ScriptVersionInfo {
  id: string;
  versionNo: number;
  publishedAt: Date | null;
  publishedByName: string | null;
  createdAt: Date;
  live: boolean;
}

export interface ScriptForEditing extends ScriptSummary {
  version: number;
  archivedAt: Date | null;
  /** The content the editor starts from: the draft, else the live version, else empty. */
  editing: ScriptContent;
  /** The draft's version for optimistic locking, or 0 when there is no draft. */
  draftVersion: number;
  draftVersionNo: number | null;
  live: ScriptContent | null;
  versions: ScriptVersionInfo[];
}

/** One script with its draft, live content and version history (script.manage). */
export async function getScriptForEditing(
  ctx: RequestContext,
  scriptId: string,
): Promise<ScriptForEditing> {
  authorize(ctx, 'script.manage');
  const id = parseScriptId(scriptId);
  return tenantRunner().withTenant(ctx.tenant, async (tx) => {
    const s = await tx.callScript.findFirst({
      where: { id },
      include: {
        versions: {
          orderBy: { versionNo: 'desc' },
          include: { publisher: { select: { user: { select: { name: true } } } } },
        },
      },
    });
    if (!s) throw notFound('Script not found');
    const draft = s.versions.find((v) => v.publishedAt === null) ?? null;
    const liveV = s.versions.find((v) => v.id === s.currentVersionId) ?? null;
    const live = liveV ? readContent(liveV.content) : null;
    return {
      id: s.id,
      name: s.name,
      status: s.status as ScriptStatus,
      liveVersionNo: liveV?.versionNo ?? null,
      hasDraft: draft !== null && s.status !== 'ARCHIVED',
      updatedAt: s.updatedAt,
      transactionTypes: s.transactionTypes,
      propertyTypes: s.propertyTypes,
      languages: s.languages,
      sourceIds: s.sourceIds,
      version: s.version,
      archivedAt: s.archivedAt,
      editing: draft ? readContent(draft.content) : (live ?? EMPTY_CONTENT),
      draftVersion: draft?.version ?? 0,
      draftVersionNo: draft?.versionNo ?? null,
      live,
      versions: s.versions.map((v) => ({
        id: v.id,
        versionNo: v.versionNo,
        publishedAt: v.publishedAt,
        publishedByName: v.publisher?.user.name ?? null,
        createdAt: v.createdAt,
        live: v.id === s.currentVersionId,
      })),
    };
  });
}

export interface PublishedScript extends ScriptTargeting {
  id: string;
  name: string;
  /** The live version's own id (FR-098 records this exact version, never "the latest"). */
  versionId: string;
  versionNo: number;
  publishedAt: Date;
  content: ScriptContent;
}

/** Published scripts with their live version (script.read; sales roles see only these). */
export async function listPublishedScripts(ctx: RequestContext): Promise<PublishedScript[]> {
  authorize(ctx, 'script.read');
  return tenantRunner().withTenant(ctx.tenant, async (tx) => {
    const rows = await tx.callScript.findMany({
      where: { status: 'PUBLISHED' },
      include: { currentVersion: true },
    });
    return rows
      .filter((s) => s.currentVersion?.publishedAt)
      .map((s) => ({
        id: s.id,
        name: s.name,
        versionId: s.currentVersion!.id,
        versionNo: s.currentVersion!.versionNo,
        publishedAt: s.currentVersion!.publishedAt!,
        content: readContent(s.currentVersion!.content),
        transactionTypes: s.transactionTypes,
        propertyTypes: s.propertyTypes,
        languages: s.languages,
        sourceIds: s.sourceIds,
      }))
      .sort(
        (a, b) =>
          a.name.toLowerCase().localeCompare(b.name.toLowerCase(), 'en') || (a.id < b.id ? -1 : 1),
      );
  });
}

/** One published script's live version (script.read). Drafts and archived scripts: not found. */
export async function getPublishedScript(
  ctx: RequestContext,
  scriptId: string,
): Promise<PublishedScript> {
  const id = parseScriptId(scriptId);
  const found = (await listPublishedScripts(ctx)).find((s) => s.id === id);
  if (!found) throw notFound('Script not found');
  return found;
}

/**
 * FR-096: published scripts matching a lead, best match first (matching.ts documents the
 * order). Needs script.read and lead.read on the lead. The lead-page script panel (FR-057/FR-099)
 * shows the first few, best match first.
 */
export async function suggestForLead(
  ctx: RequestContext,
  leadId: string,
): Promise<(PublishedScript & { score: number })[]> {
  authorize(ctx, 'script.read');
  const leadScope = authorize(ctx, 'lead.read');
  const lead = await tenantRunner().withTenant(ctx.tenant, async (tx) => {
    const { id } = await leadForTask(tx, ctx, leadScope, leadId, { write: false });
    return tx.lead.findFirstOrThrow({
      where: { id },
      select: {
        transactionType: true,
        propertyType: true,
        preferredLanguage: true,
        sourceId: true,
      },
    });
  });
  return rankScripts(await listPublishedScripts(ctx), lead);
}
