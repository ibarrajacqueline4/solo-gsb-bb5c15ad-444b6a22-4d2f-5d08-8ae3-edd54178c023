import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, type DB } from '../db';
import {
  createProject,
  importVersion,
  addAnnotation,
  getComparisonDetail,
  type ImportResult,
} from '../service';

const V1 = '第一条 甲。\n\n第二条 乙。';
const V2 = '第一条 甲（修订）。\n\n第二条 乙。';
const V3 = '第一条 甲（修订版）。\n\n第二条 乙，补充。';

/** 导入并断言成功，返回 ok 结果 */
function mustImport(
  db: DB,
  pid: number,
  label: string,
  content: string,
  baselineVersionId?: number
): ImportResult {
  const r = importVersion(db, pid, label, content, baselineVersionId);
  if (r.status !== 'ok') throw new assert.AssertionError({ message: `导入失败：${r.status}` });
  return r;
}

function setupThreeVersions() {
  const db = openDb(':memory:');
  const pid = createProject(db, '基线测试办法');
  const r1 = mustImport(db, pid, 'v1', V1);
  const r2 = mustImport(db, pid, 'v2', V2);
  const r3 = mustImport(db, pid, 'v3', V3);
  return { db, pid, r1, r2, r3 };
}

test('首版仅存档：无比对、无基线，迁移摘要标记 first_version', () => {
  const db = openDb(':memory:');
  const pid = createProject(db, 'P');
  const r1 = mustImport(db, pid, 'v1', V1);
  assert.equal(r1.comparisonId, null);
  assert.equal(r1.fragmentCount, 0);
  assert.equal(r1.baselineVersionId, null);
  assert.equal(r1.baselineSeq, null);
  assert.equal(r1.baselineLabel, null);
  assert.equal(r1.baselineExplicit, false);
  assert.deepEqual(r1.migration, {
    total: 0,
    migrated: 0,
    pending: 0,
    source_comparison_id: null,
    skip_reason: 'first_version',
  });
});

test('默认基线为项目最新版本（v2），并回填基线信息', () => {
  const { r1, r2 } = setupThreeVersions();
  assert.ok(r2.comparisonId != null);
  assert.equal(r2.baselineVersionId, r1.versionId);
  assert.equal(r2.baselineSeq, 1);
  assert.equal(r2.baselineLabel, 'v1');
  assert.equal(r2.baselineExplicit, false);
  assert.equal(r2.migration!.skip_reason, 'no_baseline_comparison');
  assert.equal(r2.migration!.source_comparison_id, null);
});

test('可指定本项目任一更早历史版本为基线，差异按所选基线生成', () => {
  const { db, pid, r1, r3 } = setupThreeVersions();
  // v4 跳过 v3，直接以 v1 为基线：差异应是 V1 → V4 的差异（而非 V3 → V4）
  const V4 = '总则 为加强管理特制定本规范。\n\n第二条 乙。';
  const r4 = mustImport(db, pid, 'v4', V4, r1.versionId);

  assert.ok(r4.comparisonId != null);
  assert.equal(r4.baselineVersionId, r1.versionId);
  assert.equal(r4.baselineSeq, 1);
  assert.equal(r4.baselineLabel, 'v1');
  assert.equal(r4.baselineExplicit, true);
  assert.equal(r4.seq, 4);

  const cmp = db
    .prepare('SELECT old_version_id, new_version_id FROM comparisons WHERE id = ?')
    .get(r4.comparisonId) as { old_version_id: number; new_version_id: number };
  assert.equal(cmp.old_version_id, r1.versionId);
  assert.equal(cmp.new_version_id, r4.versionId);

  // V1 第一条被删除、V4 第一条新增（不是「修改」，因为与 V3 无关）
  const detail = getComparisonDetail(db, r4.comparisonId!)!;
  assert.equal(detail.comparison.old_seq, 1);
  assert.equal(detail.comparison.new_seq, 4);
  assert.equal(detail.comparison.skipped_version_count, 2); // 跳过 v2、v3
  const types = detail.fragments.map((f) => f.type).sort();
  assert.deepEqual(types, ['added', 'removed']);
  assert.equal(detail.fragments.find((f) => f.type === 'removed')!.old_text, '第一条 甲。');
});

test('基线不存在 / 属于其他项目 / 项目不存在时返回明确错误状态', () => {
  const { db, pid } = setupThreeVersions();
  const otherPid = createProject(db, '另一个项目');
  const other = mustImport(db, otherPid, 'w1', '完全无关的文本内容。');

  assert.equal(importVersion(db, pid, 'x', V3, 99999).status, 'baseline_not_found');
  assert.equal(
    importVersion(db, pid, 'x', V3, other.versionId).status,
    'baseline_foreign_project'
  );
  assert.equal(importVersion(db, 99999, 'x', V3).status, 'project_not_found');

  // 校验失败必须整体回滚：没有留下版本或比对
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS n FROM versions WHERE project_id = ?').get(pid) as { n: number }).n,
    3
  );
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS n FROM comparisons WHERE project_id = ?').get(pid) as { n: number }).n,
    2
  );
});

test('批注只从「以所选基线为新版的最近一轮比对」迁移，绝不从项目最新比对误带', () => {
  const db = openDb(':memory:');
  const pid = createProject(db, '迁移来源测试');
  const s1 = mustImport(db, pid, 'v1', V1);
  const s2 = mustImport(db, pid, 'v2', V2);

  // A = v1→v2：在 A 的片段上留一条未解决批注 annA（锚定 v2 文本）
  const fA = (
    db
      .prepare('SELECT id, new_text FROM fragments WHERE comparison_id = ?')
      .all(s2.comparisonId!) as Array<{ id: number; new_text: string | null }>
  ).find((f) => f.new_text!.includes('甲（修订）'))!;
  const addA = addAnnotation(db, fA.id, '甲作者', 'A 轮专属批注锚定 v2 文本');
  assert.equal(addA.status, 'ok');
  const annAId = (addA as { id: number }).id;

  // v3 默认导入（B = v2→v3）：annA 复制迁移到 B
  const s3 = mustImport(db, pid, 'v3', V3);
  const detailB = getComparisonDetail(db, s3.comparisonId!)!;
  assert.equal(detailB.stats.annotations.total, 1);
  const annInB = detailB.fragments.flatMap((f) => f.annotations)[0];
  assert.equal(annInB.migrated_from, annAId);

  // 在 B 上再挂一条全新批注（B 轮特有，A 轮没有）
  const fB = detailB.fragments.find((f) => f.new_text!.includes('修订版'))!;
  const addB = addAnnotation(db, fB.id, '乙作者', 'B 轮专属批注，基线选 v1 时绝不能被带到下一轮');
  assert.equal(addB.status, 'ok');

  // v4 显式以 v1 为基线：没有任何「以 v1 为新版」的比对 → 明确不迁移，且不得从 B 误带
  const V4fromV1 = '第一条 甲（修订）增补。\n\n第二条 乙。';
  const s4 = mustImport(db, pid, 'v4', V4fromV1, s1.versionId);
  assert.equal(s4.baselineVersionId, s1.versionId);
  assert.equal(s4.migration!.total, 0);
  assert.equal(s4.migration!.migrated, 0);
  assert.equal(s4.migration!.pending, 0);
  assert.equal(s4.migration!.source_comparison_id, null);
  assert.equal(s4.migration!.skip_reason, 'no_baseline_comparison');
  const detailV4fromV1 = getComparisonDetail(db, s4.comparisonId!)!;
  assert.equal(detailV4fromV1.stats.annotations.total, 0);

  // v5 显式以 v2 为基线：迁移来源必须是 A（new_version_id = v2），不是项目最新比对 B；
  // V5 文本贴近 v2，使 annA 能成功锚定。
  const V5fromV2 = '第一条 甲（修订）续。\n\n第二条 乙。';
  const s5 = mustImport(db, pid, 'v5', V5fromV2, s2.versionId);
  assert.equal(s5.migration!.source_comparison_id, s2.comparisonId);
  assert.equal(s5.migration!.skip_reason, null);
  assert.equal(s5.migration!.total, 1);
  assert.equal(s5.migration!.migrated, 1);
  const detailV5 = getComparisonDetail(db, s5.comparisonId!)!;
  const annsV5 = detailV5.fragments.flatMap((f) => f.annotations);
  assert.equal(annsV5.length, 1);
  // migrated_from 指向 A 轮的原始批注，而不是 B 轮的迁移副本
  assert.equal(annsV5[0].migrated_from, annAId);
  assert.notEqual(annsV5[0].migrated_from, annInB.id);
  assert.equal(annsV5[0].content, 'A 轮专属批注锚定 v2 文本');
  // B 轮专属批注绝不能出现
  assert.ok(annsV5.every((a) => !a.content.includes('B 轮专属批注')));
});

test('默认导入后续版本时，迁移来源是以最新版本为新版的比对（原行为保持）', () => {
  const db = openDb(':memory:');
  const pid = createProject(db, '默认来源测试');
  const s1 = mustImport(db, pid, 'v1', V1);
  const s2 = mustImport(db, pid, 'v2', V2);
  const f = (
    db
      .prepare('SELECT id, new_text FROM fragments WHERE comparison_id = ?')
      .all(s2.comparisonId!) as Array<{ id: number; new_text: string | null }>
  ).find((x) => x.new_text!.includes('甲（修订）'))!;
  addAnnotation(db, f.id, '作者', '待迁移批注');

  // v3 默认基线（v3 seq 之前的最新版本 = v2）→ 来源比对正是 s2
  const s3 = mustImport(db, pid, 'v3', V3);
  assert.equal(s3.baselineVersionId, s2.versionId);
  assert.equal(s3.baselineExplicit, false);
  assert.equal(s3.migration!.source_comparison_id, s2.comparisonId);
  assert.equal(s3.migration!.total, 1);
});

test('先跨版本导入（v1→v3）后再正常导入 v4，迁移来源切换为最近的 v3 比对', () => {
  const db = openDb(':memory:');
  const pid = createProject(db, '来源切换测试');
  const s1 = mustImport(db, pid, 'v1', V1);
  const s2 = mustImport(db, pid, 'v2', V2);
  // 在 v1→v2 上放批注
  const fA = (
    db
      .prepare('SELECT id FROM fragments WHERE comparison_id = ? AND new_text IS NOT NULL')
      .all(s2.comparisonId!) as Array<{ id: number }>
  )[0];
  addAnnotation(db, fA.id, '作者', '历史批注');
  // 跨版本：v3 以 v1 为基线（来源缺失 → 不迁移）
  const s3 = mustImport(db, pid, 'v3', V3, s1.versionId);
  assert.equal(s3.migration!.skip_reason, 'no_baseline_comparison');

  // v4 默认以最新版本 v3 为基线 → 来源为 s3 这轮比对（以 v3 为新版的最近一轮）
  const V4 = '第一条 甲（修订版）微调。\n\n第二条 乙，补充。';
  const s4 = mustImport(db, pid, 'v4', V4);
  assert.equal(s4.baselineVersionId, s3.versionId);
  assert.equal(s4.migration!.source_comparison_id, s3.comparisonId);
  // s3 轮没有批注（上一步未迁移），故本轮无可迁移批注
  assert.equal(s4.migration!.total, 0);
  assert.equal(s4.migration!.skip_reason, null);
});
