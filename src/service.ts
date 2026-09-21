import type { DB } from './db';
import { splitParagraphs, buildFragments } from './diff';
import { migrateAnnotations, type MigrationResult } from './migrate';

export function createProject(db: DB, name: string): number {
  const info = db.prepare('INSERT INTO projects (name) VALUES (?)').run(name);
  return Number(info.lastInsertRowid);
}

/** 批注迁移的轮次来源信息 */
export interface MigrationSummary {
  /** 参与迁移的未解决批注总数 */
  total: number;
  /** 成功锚定到新片段的数量 */
  migrated: number;
  /** 无法匹配、被标记为「待复核」的数量 */
  pending: number;
  /** 本轮批注迁移取自哪一轮比对（new_version_id = 所选基线）；不存在则为 null */
  source_comparison_id: number | null;
  /** 未发生迁移时的原因 */
  skip_reason: 'first_version' | 'no_baseline_comparison' | null;
}

export interface ImportResult {
  status: 'ok';
  versionId: number;
  seq: number;
  comparisonId: number | null;
  fragmentCount: number;
  /** 实际使用的比对基线版本（首版无基线） */
  baselineVersionId: number | null;
  baselineSeq: number | null;
  baselineLabel: string | null;
  /** 是否为调用方显式指定的基线（false = 默认最新版本 / 首版） */
  baselineExplicit: boolean;
  migration: MigrationSummary | null;
}

export type ImportVersionResult =
  | ImportResult
  | { status: 'project_not_found' }
  | { status: 'baseline_not_found' }
  | { status: 'baseline_foreign_project' }
  | { status: 'baseline_not_earlier' };

interface VersionRow {
  id: number;
  project_id: number;
  label: string;
  seq: number;
  content: string;
}

/**
 * 导入一个版本：
 *  - 首版仅存档（不允许携带基线）；
 *  - 其后默认以项目内最新版本为「比对基线」自动生成差异片段，
 *    也可由 baselineVersionId 显式指定本项目任一更早的历史版本；
 *  - 批注仅从「以该基线为新版的最近一轮比对」迁移，
 *    找不到这样的比对时明确不迁移（禁止回退到项目最新比对）。
 * 全部步骤在同一个数据库事务内完成，任何校验失败整体回滚。
 */
export function importVersion(
  db: DB,
  projectId: number,
  label: string,
  content: string,
  baselineVersionId?: number | null
): ImportVersionResult {
  const tx = db.transaction((): ImportVersionResult => {
    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
    if (!project) return { status: 'project_not_found' };

    const prev = db
      .prepare('SELECT id, seq, content FROM versions WHERE project_id = ? ORDER BY seq DESC LIMIT 1')
      .get(projectId) as Pick<VersionRow, 'id' | 'seq' | 'content'> | undefined;

    const seq = prev ? prev.seq + 1 : 1;

    // 基线解析：未指定时默认最新版本；显式指定时校验归属与先后
    let baseline: Pick<VersionRow, 'id' | 'seq' | 'label' | 'content'> | null = null;
    let baselineExplicit = false;
    if (baselineVersionId != null) {
      baselineExplicit = true;
      const row = db
        .prepare('SELECT id, project_id, label, seq, content FROM versions WHERE id = ?')
        .get(baselineVersionId) as Pick<VersionRow, 'id' | 'project_id' | 'label' | 'seq' | 'content'> | undefined;
      if (!row) return { status: 'baseline_not_found' };
      if (row.project_id !== projectId) return { status: 'baseline_foreign_project' };
      // 新版本尚未入库，其序号为 seq；基线必须严格早于新版本
      if (row.seq >= seq) return { status: 'baseline_not_earlier' };
      baseline = row;
    } else if (prev) {
      const row = db
        .prepare('SELECT id, label, seq, content FROM versions WHERE id = ?')
        .get(prev.id) as Pick<VersionRow, 'id' | 'label' | 'seq' | 'content'>;
      baseline = row;
    }

    const versionId = Number(
      db
        .prepare('INSERT INTO versions (project_id, label, content, seq) VALUES (?, ?, ?, ?)')
        .run(projectId, label, content, seq).lastInsertRowid
    );

    if (!baseline) {
      return {
        status: 'ok',
        versionId,
        seq,
        comparisonId: null,
        fragmentCount: 0,
        baselineVersionId: null,
        baselineSeq: null,
        baselineLabel: null,
        baselineExplicit: false,
        migration: {
          total: 0,
          migrated: 0,
          pending: 0,
          source_comparison_id: null,
          skip_reason: 'first_version',
        },
      };
    }

    const comparisonId = Number(
      db
        .prepare('INSERT INTO comparisons (project_id, old_version_id, new_version_id) VALUES (?, ?, ?)')
        .run(projectId, baseline.id, versionId).lastInsertRowid
    );

    const fragments = buildFragments(splitParagraphs(baseline.content), splitParagraphs(content));
    const insertFragment = db.prepare(
      `INSERT INTO fragments (comparison_id, ord, type, old_text, new_text, old_start, new_start, anchor)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const f of fragments) {
      insertFragment.run(
        comparisonId,
        f.ord,
        f.type,
        f.oldText,
        f.newText,
        f.oldStart,
        f.newStart,
        f.newText ?? f.oldText ?? ''
      );
    }

    // 批注迁移只允许来自「以该基线为新版的最近一轮比对」，
    // 绝不能退回项目最新比对，避免把别的基线上的批注误带入本轮。
    const sourceComparison = db
      .prepare(
        `SELECT id FROM comparisons
          WHERE project_id = ? AND new_version_id = ?
          ORDER BY id DESC LIMIT 1`
      )
      .get(projectId, baseline.id) as { id: number } | undefined;

    let migration: MigrationSummary;
    if (sourceComparison) {
      const r: MigrationResult = migrateAnnotations(db, sourceComparison.id, comparisonId);
      migration = { ...r, source_comparison_id: sourceComparison.id, skip_reason: null };
    } else {
      migration = {
        total: 0,
        migrated: 0,
        pending: 0,
        source_comparison_id: null,
        skip_reason: 'no_baseline_comparison',
      };
    }

    return {
      status: 'ok',
      versionId,
      seq,
      comparisonId,
      fragmentCount: fragments.length,
      baselineVersionId: baseline.id,
      baselineSeq: baseline.seq,
      baselineLabel: baseline.label,
      baselineExplicit,
      migration,
    };
  });
  return tx();
}

/** 在差异片段上创建批注，锚点取片段当前（新）文本。
 *  已封存的比对禁止新增批注（sealed）；片段不存在返回 null。 */
export function addAnnotation(
  db: DB,
  fragmentId: number,
  author: string,
  content: string
): { status: 'ok'; id: number } | { status: 'not_found' } | { status: 'sealed' } {
  const frag = db
    .prepare(
      `SELECT f.id, f.comparison_id, f.old_text, f.new_text, c.sealed_at
         FROM fragments f JOIN comparisons c ON c.id = f.comparison_id
        WHERE f.id = ?`
    )
    .get(fragmentId) as
    | { id: number; comparison_id: number; old_text: string | null; new_text: string | null; sealed_at: string | null }
    | undefined;
  if (!frag) return { status: 'not_found' };
  if (frag.sealed_at != null) return { status: 'sealed' };
  const anchor = frag.new_text ?? frag.old_text ?? '';
  const info = db
    .prepare(
      `INSERT INTO annotations (comparison_id, fragment_id, author, content, status, anchor_text)
       VALUES (?, ?, ?, ?, 'open', ?)`
    )
    .run(frag.comparison_id, fragmentId, author, content, anchor);
  return { status: 'ok', id: Number(info.lastInsertRowid) };
}

export type FragmentDecision = 'accepted' | 'rejected' | 'deferred';
export const FRAGMENT_DECISIONS: readonly FragmentDecision[] = ['accepted', 'rejected', 'deferred'];

export interface Blocker {
  kind: 'undecided_fragment' | 'open_annotation' | 'pending_review_annotation';
  message: string;
  fragment_ord?: number;
  annotation_id?: number;
}

export type SaveDecisionResult =
  | { status: 'ok' }
  | { status: 'not_found' }
  | { status: 'sealed' }
  | { status: 'reason_required' };

/**
 * 保存片段审阅结论：接受变更 / 拒绝变更 / 暂缓。
 * 暂缓（deferred）必须填写理由。已封存的比对禁止修改结论。
 */
export function saveFragmentDecision(
  db: DB,
  fragmentId: number,
  decision: FragmentDecision,
  reason: string | null,
  decidedBy: string | null
): SaveDecisionResult {
  const frag = db
    .prepare(
      `SELECT f.id, c.sealed_at
         FROM fragments f JOIN comparisons c ON c.id = f.comparison_id
        WHERE f.id = ?`
    )
    .get(fragmentId) as { id: number; sealed_at: string | null } | undefined;
  if (!frag) return { status: 'not_found' };
  if (frag.sealed_at != null) return { status: 'sealed' };
  if (decision === 'deferred' && (reason == null || !reason.trim())) {
    return { status: 'reason_required' };
  }
  db.prepare(
    `UPDATE fragments
        SET decision = ?, decision_reason = ?, decided_by = ?,
            decided_at = datetime('now', 'localtime')
      WHERE id = ?`
  ).run(
    decision,
    decision === 'deferred' ? reason!.trim() : null,
    decidedBy,
    fragmentId
  );
  return { status: 'ok' };
}

/** 汇总封存前的全部阻塞项：未作结论的片段、未解决 / 待复核批注 */
export function getSealBlockers(db: DB, comparisonId: number): Blocker[] {
  const blockers: Blocker[] = [];
  const undecided = db
    .prepare(`SELECT ord FROM fragments WHERE comparison_id = ? AND decision IS NULL ORDER BY ord`)
    .all(comparisonId) as Array<{ ord: number }>;
  for (const f of undecided) {
    blockers.push({
      kind: 'undecided_fragment',
      fragment_ord: f.ord,
      message: `片段 #${f.ord} 尚未作出审阅结论`,
    });
  }
  const anns = db
    .prepare(
      `SELECT id, status, fragment_id
         FROM annotations
        WHERE comparison_id = ? AND status IN ('open', 'pending_review')
        ORDER BY id`
    )
    .all(comparisonId) as Array<{ id: number; status: string; fragment_id: number | null }>;
  for (const a of anns) {
    const suffix = a.fragment_id == null ? '（位于待复核区）' : '';
    blockers.push({
      kind: a.status === 'open' ? 'open_annotation' : 'pending_review_annotation',
      annotation_id: a.id,
      message:
        a.status === 'open'
          ? `存在未解决批注 #${a.id}${suffix}`
          : `存在待复核批注 #${a.id}${suffix}`,
    });
  }
  return blockers;
}

export interface SealedComparison {
  sealed_by: string;
  sealed_at: string;
}

export type SealResult =
  | { status: 'ok'; sealed: SealedComparison }
  | { status: 'not_found' }
  | { status: 'already_sealed'; sealed: SealedComparison }
  | { status: 'blocked'; blockers: Blocker[] };

/**
 * 封存比对：服务端在单个事务内再次校验
 *（全部片段已有结论、不存在未解决 / 待复核批注），
 * 任何阻塞项都会回滚并返回明细。
 */
export function sealComparison(
  db: DB,
  comparisonId: number,
  sealedBy: string
): SealResult {
  const tx = db.transaction((): SealResult => {
    const cmpRow = db
      .prepare('SELECT sealed_by, sealed_at FROM comparisons WHERE id = ?')
      .get(comparisonId) as { sealed_by: string | null; sealed_at: string | null } | undefined;
    if (!cmpRow) return { status: 'not_found' };
    if (cmpRow.sealed_at != null) {
      return {
        status: 'already_sealed',
        sealed: { sealed_by: cmpRow.sealed_by ?? '', sealed_at: cmpRow.sealed_at },
      };
    }

    const blockers = getSealBlockers(db, comparisonId);
    if (blockers.length > 0) return { status: 'blocked', blockers };

    db.prepare(
      `UPDATE comparisons
          SET sealed_by = ?, sealed_at = datetime('now', 'localtime')
        WHERE id = ? AND sealed_at IS NULL`
    ).run(sealedBy, comparisonId);

    const row = db
      .prepare('SELECT sealed_by, sealed_at FROM comparisons WHERE id = ?')
      .get(comparisonId) as { sealed_by: string; sealed_at: string };
    return { status: 'ok', sealed: { sealed_by: row.sealed_by, sealed_at: row.sealed_at } };
  });
  return tx();
}

/** 批注是否处于已封存比对（用于编辑 / 改状态 / 删除前的写保护） */
export function isAnnotationSealed(db: DB, annotationId: number): boolean | null {
  const row = db
    .prepare('SELECT c.sealed_at FROM annotations a JOIN comparisons c ON c.id = a.comparison_id WHERE a.id = ?')
    .get(annotationId) as { sealed_at: string | null } | undefined;
  if (!row) return null;
  return row.sealed_at != null;
}

export type UpdateAnnotationResult = { status: 'ok' } | { status: 'not_found' } | { status: 'sealed' };

/** 更新批注状态 / 内容，已封存的比对一律拒绝 */
export function updateAnnotation(
  db: DB,
  annotationId: number,
  status: string | null,
  content: string | null
): UpdateAnnotationResult {
  const ann = db
    .prepare(
      `SELECT a.status, a.content, c.sealed_at
         FROM annotations a JOIN comparisons c ON c.id = a.comparison_id
        WHERE a.id = ?`
    )
    .get(annotationId) as
    | { status: string; content: string; sealed_at: string | null }
    | undefined;
  if (!ann) return { status: 'not_found' };
  if (ann.sealed_at != null) return { status: 'sealed' };
  db.prepare(
    `UPDATE annotations
        SET status = ?, content = ?, updated_at = datetime('now', 'localtime')
      WHERE id = ?`
  ).run(status ?? ann.status, content ?? ann.content, annotationId);
  return { status: 'ok' };
}

/** 删除批注，已封存的比对一律拒绝 */
export function deleteAnnotation(
  db: DB,
  annotationId: number
): { status: 'ok' } | { status: 'not_found' } | { status: 'sealed' } {
  const sealed = isAnnotationSealed(db, annotationId);
  if (sealed == null) return { status: 'not_found' };
  if (sealed) return { status: 'sealed' };
  db.prepare('DELETE FROM annotations WHERE id = ?').run(annotationId);
  return { status: 'ok' };
}

export interface AnnotationRow {
  id: number;
  comparison_id: number;
  fragment_id: number | null;
  author: string;
  content: string;
  status: 'open' | 'resolved' | 'pending_review';
  anchor_text: string | null;
  similarity: number | null;
  migrated_from: number | null;
  created_at: string;
  updated_at: string;
}

export interface FragmentRow {
  id: number;
  comparison_id: number;
  ord: number;
  type: 'added' | 'removed' | 'changed';
  old_text: string | null;
  new_text: string | null;
  old_start: number | null;
  new_start: number | null;
  anchor: string | null;
  decision: FragmentDecision | null;
  decision_reason: string | null;
  decided_by: string | null;
  decided_at: string | null;
}

export interface ComparisonDetail {
  comparison: {
    id: number;
    project_id: number;
    project_name: string;
    old_version_id: number;
    new_version_id: number;
    old_seq: number;
    new_seq: number;
    /** 基线与新版之间跳过的版本数；0 表示相邻版本比对 */
    skipped_version_count: number;
    old_label: string;
    new_label: string;
    sealed_by: string | null;
    sealed_at: string | null;
    created_at: string;
  };
  fragments: Array<FragmentRow & { annotations: AnnotationRow[] }>;
  /** 无法锚定到任何片段的批注（待复核） */
  unanchored: AnnotationRow[];
  stats: {
    added: number;
    removed: number;
    changed: number;
    annotations: { open: number; resolved: number; pending_review: number; total: number };
    decisions: {
      accepted: number;
      rejected: number;
      deferred: number;
      undecided: number;
      total: number;
    };
  };
}

export function getComparisonDetail(db: DB, comparisonId: number): ComparisonDetail | null {
  const comparison = db
    .prepare(
      `SELECT c.id, c.project_id, c.created_at, c.sealed_by, c.sealed_at,
              c.old_version_id, c.new_version_id,
              ov.seq AS old_seq, nv.seq AS new_seq,
              (nv.seq - ov.seq - 1) AS skipped_version_count,
              p.name AS project_name,
              ov.label AS old_label,
              nv.label AS new_label
         FROM comparisons c
         JOIN projects p ON p.id = c.project_id
         JOIN versions ov ON ov.id = c.old_version_id
         JOIN versions nv ON nv.id = c.new_version_id
        WHERE c.id = ?`
    )
    .get(comparisonId) as ComparisonDetail['comparison'] | undefined;
  if (!comparison) return null;

  const fragments = db
    .prepare('SELECT * FROM fragments WHERE comparison_id = ? ORDER BY ord')
    .all(comparisonId) as FragmentRow[];
  const annotations = db
    .prepare('SELECT * FROM annotations WHERE comparison_id = ? ORDER BY id')
    .all(comparisonId) as AnnotationRow[];

  const byFragment = new Map<number, AnnotationRow[]>();
  const unanchored: AnnotationRow[] = [];
  for (const a of annotations) {
    if (a.fragment_id == null) {
      unanchored.push(a);
    } else {
      const list = byFragment.get(a.fragment_id) ?? [];
      list.push(a);
      byFragment.set(a.fragment_id, list);
    }
  }

  const stats: ComparisonDetail['stats'] = {
    added: 0,
    removed: 0,
    changed: 0,
    annotations: { open: 0, resolved: 0, pending_review: 0, total: annotations.length },
    decisions: { accepted: 0, rejected: 0, deferred: 0, undecided: 0, total: fragments.length },
  };
  for (const f of fragments) {
    stats[f.type]++;
    if (f.decision == null) stats.decisions.undecided++;
    else stats.decisions[f.decision]++;
  }
  for (const a of annotations) stats.annotations[a.status]++;

  return {
    comparison,
    fragments: fragments.map((f) => ({ ...f, annotations: byFragment.get(f.id) ?? [] })),
    unanchored,
    stats,
  };
}
